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

        // Call Replicate API - fofr/face-to-many
        // Uses InstantID internally with preset styles for fast, high-fidelity face generation
        console.log("Generating with fofr/face-to-many...");
        const output = await replicate.run(
            "fofr/face-to-many:a07f252abbbd832009640b27f063ea52d87d7a23a185ca165bec23b5adc8deaf",
            {
                input: {
                    image: `data:image/jpeg;base64,${image}`,
                    style: "3D", // Options: 3D, Emoji, Video game, Pixels, Clay, Toy
                    prompt: prompt, // Theme-specific prompt
                    lora_scale: 1,
                    negative_prompt: "ugly, blurry, low quality, distorted",
                    prompt_strength: 4.5,
                    denoising_strength: 0.65,
                    instant_id_strength: 1.0, // Maximum identity preservation
                    control_depth_strength: 0.8
                },
            }
        );

        if (!output) {
            return res.status(500).json({ error: "AI görsel üretemedi" });
        }

        // fofr/face-to-many returns a single URL string
        const imageUrl = typeof output === 'string' ? output : output[0];
        const imageResponse = await fetch(imageUrl);
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
            output: imageUrl,
            image: base64Image,
            remainingCredits: creditData.balance - 1,
        });

    } catch (error) {
        console.error("Generate error:", error);
        return res.status(500).json({ error: error.message || "Bir hata oluştu" });
    }
}
