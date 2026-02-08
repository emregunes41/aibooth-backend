import { createClient } from "@supabase/supabase-js";
import Replicate from "replicate";

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
});

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

        // Call Replicate API - Hybrid Approach (Flux Schnell + FaceSwap)
        // Step 1: Generate base image with Flux Schnell (Fast & Cheap)
        console.log("Step 1: Generating base image with Flux Schnell...");
        const fluxOutput = await replicate.run(
            "benjaming/flux:7456b4edc96c9c1be4398874865c7b2563920186032c858e8061e14692673ad2",
            {
                input: {
                    model: "schnell",
                    image: `data:image/jpeg;base64,${image}`,
                    prompt: `${prompt}, medium shot, 2:3 aspect ratio, detailed eyes, detailed texture`,
                    width: 832,
                    height: 1216,
                    num_inference_steps: 4,
                    guidance_scale: 3.5,
                    prompt_strength: 0.8, // Allow heavy change to fit theme
                    seed: Math.floor(Math.random() * 1000000),
                    num_outputs: 1,
                    output_format: "webp",
                    output_quality: 95,
                    go_fast: true,
                    disable_safety_checker: false
                },
            }
        );

        if (!fluxOutput || fluxOutput.length === 0) {
            return res.status(500).json({ error: "Step 1: Flux AI görsel üretemedi" });
        }

        const generatedImageUrl = fluxOutput[0];
        console.log("Step 1 Complete. URL:", generatedImageUrl);

        // Step 2: Swap Face using lucataco/faceswap (InsightFace)
        // Model: lucataco/faceswap:9a4298548422074c3f57258c5d544497314ae4112df80d116f0d2109bd92a8af
        console.log("Step 2: Swapping face...");
        const swapOutput = await replicate.run(
            "lucataco/faceswap:9a4298548422074c3f57258c5d544497314ae4112df80d116f0d2109bd92a8af",
            {
                input: {
                    target_image: generatedImageUrl,
                    swap_image: `data:image/jpeg;base64,${image}`,
                }
            }
        );

        let finalImageUrl;
        if (swapOutput) {
            // Swap output is commonly a string URL or object depending on version
            // Based on schema check, it is URI string
            finalImageUrl = typeof swapOutput === 'string' ? swapOutput : swapOutput[0];
        } else {
            // Fallback to Flux output if swap fails? Or error?
            console.error("Step 2 Failed. Falling back to Flux output.");
            finalImageUrl = generatedImageUrl;
        }

        // For consistency with existing code, wrap in array if needed or just handle it
        const output = [finalImageUrl];


        if (!output || output.length === 0) {
            return res.status(500).json({ error: "AI görsel üretemedi" });
        }

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

        // Get the image and return
        const imageUrl = output[0];
        const imageResponse = await fetch(imageUrl);
        const imageBuffer = await imageResponse.arrayBuffer();
        const base64Image = Buffer.from(imageBuffer).toString("base64");

        return res.status(200).json({
            success: true,
            output: imageUrl,
            image: base64Image,
            remainingCredits: creditData.balance - 1,
        });

    } catch (error) {
        console.error("Generate error:", error);
        return res.status(500).json({ error: error.message || "Bir hata oluştu" });
    }
}
