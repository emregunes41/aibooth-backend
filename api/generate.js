import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FAL_KEY = process.env.FAL_KEY;

export default async function handler(req, res) {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        // Verify auth token
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            return res.status(401).json({ error: "Giriş yapmanız gerekiyor" });
        }

        const token = authHeader.replace("Bearer ", "");

        const anonSupabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_ANON_KEY
        );

        const { data: userData, error: userError } = await anonSupabase.auth.getUser(token);

        if (userError || !userData.user) {
            return res.status(401).json({ error: "Geçersiz oturum. Lütfen tekrar giriş yapın." });
        }

        const userId = userData.user.id;

        // Check credit balance
        const { data: creditData, error: creditError } = await supabase
            .from("credits")
            .select("balance")
            .eq("user_id", userId)
            .single();

        if (creditError || !creditData) {
            return res.status(400).json({ error: "Kredi bilgisi bulunamadı" });
        }

        if (creditData.balance < 1) {
            return res.status(402).json({ error: "Yetersiz kredi. Lütfen kredi satın alın." });
        }

        // Get image and prompt from request
        const { image, prompt, themeName } = req.body;

        if (!image || !prompt) {
            return res.status(400).json({ error: "Görsel ve prompt gerekli" });
        }

        // ============================================================
        // FAL.AI HYBRID APPROACH
        // Step 1: Generate scene with Flux Schnell (fast, cheap)
        // Step 2: Swap user's face onto the generated scene
        // ============================================================

        console.log("Step 1: Generating scene with fal.ai Flux Schnell...");

        // Step 1: Generate base scene
        const fluxResponse = await fetch("https://fal.run/fal-ai/flux/schnell", {
            method: "POST",
            headers: {
                "Authorization": `Key ${FAL_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                prompt: `${prompt}, photorealistic, high quality, detailed, professional photography`,
                image_size: "portrait_4_3",
                num_inference_steps: 4,
                num_images: 1,
                enable_safety_checker: false
            })
        });

        if (!fluxResponse.ok) {
            const error = await fluxResponse.text();
            console.error("Flux error:", error);
            return res.status(500).json({ error: "Sahne üretilemedi: " + error });
        }

        const fluxData = await fluxResponse.json();
        const sceneImageUrl = fluxData.images?.[0]?.url;

        if (!sceneImageUrl) {
            return res.status(500).json({ error: "Sahne görseli alınamadı" });
        }

        console.log("Step 1 Complete. Scene URL:", sceneImageUrl);

        // Step 2: Face Swap - Put user's face onto the generated scene
        console.log("Step 2: Swapping face with fal.ai...");

        const swapResponse = await fetch("https://fal.run/fal-ai/face-swap", {
            method: "POST",
            headers: {
                "Authorization": `Key ${FAL_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                base_image_url: sceneImageUrl,
                swap_image_url: `data:image/jpeg;base64,${image}`
            })
        });

        if (!swapResponse.ok) {
            const error = await swapResponse.text();
            console.error("Face swap error:", error);
            // Fallback to scene without face swap if it fails
            console.log("Face swap failed, returning scene only");
        }

        let finalImageUrl = sceneImageUrl;

        if (swapResponse.ok) {
            const swapData = await swapResponse.json();
            finalImageUrl = swapData.image?.url || swapData.output?.url || sceneImageUrl;
            console.log("Step 2 Complete. Final URL:", finalImageUrl);
        }

        // Fetch the final image and convert to base64
        const imageResponse = await fetch(finalImageUrl);
        const imageBuffer = await imageResponse.arrayBuffer();
        const base64Image = Buffer.from(imageBuffer).toString("base64");

        // Deduct credit
        const { error: updateError } = await supabase
            .from("credits")
            .update({
                balance: creditData.balance - 1,
                updated_at: new Date().toISOString()
            })
            .eq("user_id", userId);

        if (updateError) {
            console.error("Credit update error:", updateError);
        }

        // Log usage
        await supabase.from("usage_logs").insert({
            user_id: userId,
            credits_used: 1,
            theme_name: themeName || "Unknown",
        });

        return res.status(200).json({
            success: true,
            output: finalImageUrl,
            image: base64Image,
            remainingCredits: creditData.balance - 1,
        });

    } catch (error) {
        console.error("Generate error:", error);
        return res.status(500).json({ error: error.message || "Bir hata oluştu" });
    }
}
