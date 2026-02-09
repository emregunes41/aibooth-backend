import Replicate from "replicate";

const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
});

export default async function handler(req, res) {
    // CORS headers
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        const { prompt } = req.body;

        if (!prompt) {
            return res.status(400).json({ error: "Prompt is required" });
        }

        console.log("Generating theme preview for prompt:", prompt.substring(0, 100) + "...");

        // Use flux-schnell for fast, cheap preview generation
        const output = await replicate.run(
            "black-forest-labs/flux-schnell",
            {
                input: {
                    prompt: prompt,
                    num_outputs: 1,
                    aspect_ratio: "1:1",
                    output_format: "webp",
                    output_quality: 80
                }
            }
        );

        if (!output || output.length === 0) {
            return res.status(500).json({ error: "No image generated" });
        }

        const imageUrl = output[0];
        console.log("Theme preview generated:", imageUrl);

        // Fetch the image and return as base64
        const imageResponse = await fetch(imageUrl);
        const imageBuffer = await imageResponse.arrayBuffer();
        const base64Image = Buffer.from(imageBuffer).toString("base64");

        return res.status(200).json({
            success: true,
            image: base64Image,
            url: imageUrl
        });

    } catch (error) {
        console.error("Theme preview generation error:", error);
        return res.status(500).json({
            error: "Preview generation failed",
            details: error.message
        });
    }
}
