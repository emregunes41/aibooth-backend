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

        // Call Replicate API - InstantID Implementation
        // Model: zsxkib/instant-id -> Using "juggernaut-xl-v8" weights for best realism
        console.log("Generating with InstantID...");
        const output = await replicate.run(
            "zsxkib/instant-id:2e4785a4d80dadf580077b2244c8d7c05d8e3faac04a04c02d8e099dd2876789",
            {
                input: {
                    image: `data:image/jpeg;base64,${image}`, // Identity Source
                    pose_image: `data:image/jpeg;base64,${image}`, // Pose Source (Use user's pose)
                    prompt: `${prompt}, photorealistic, 8k, highly detailed, cinematic lighting`,
                    negative_prompt: "bad quality, worst quality, low resolution, blurry, distorted face, bad anatomy, bad eyes, crossed eyes, disfigured, extra fingers, cartoon, anime, illustration",
                    sdxl_weights: "juggernaut-xl-v8", // High quality photorealism
                    ip_adapter_scale: 0.8, // Strong identity
                    controlnet_conditioning_scale: 0.8, // Strong pose control

                    // PERFORMANCE OPTIMIZATION: Enable LCM (Latent Consistency Model)
                    enable_lcm: true, // drastically speeds up generation (2 mins -> ~5-10 seconds)
                    lcm_num_inference_steps: 5, // Very few steps needed for LCM
                    lcm_guidance_scale: 1.5,

                    num_inference_steps: 30, // Fallback if LCM fails, but LCM overrides this logic usually
                    guidance_scale: 5,
                    scheduler: "EulerDiscreteScheduler",
                    width: 832,
                    height: 1216,
                    num_outputs: 1,
                    output_format: "webp",
                    output_quality: 95,
                    disable_safety_checker: false,
                    enhance_nonface_region: true
                },
            }
        );

        if (!output || output.length === 0) {
            return res.status(500).json({ error: "InstantID görsel üretemedi" });
        }

        // Get the image and return
        // InstantID output should be an array of URIs
        const imageUrl = output[0];
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
