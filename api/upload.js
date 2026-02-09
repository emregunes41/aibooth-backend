import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
        const { image } = req.body;

        if (!image) {
            return res.status(400).json({ error: "Image data required" });
        }

        // Generate unique filename
        const filename = `share_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;

        // Convert base64 to buffer
        const imageBuffer = Buffer.from(image, "base64");

        // Upload to Supabase Storage
        const { data, error } = await supabase.storage
            .from("shared-images")
            .upload(filename, imageBuffer, {
                contentType: "image/jpeg",
                cacheControl: "3600",
                upsert: false
            });

        if (error) {
            console.error("Upload error:", error);
            return res.status(500).json({ error: "Upload failed: " + error.message });
        }

        // Get public URL
        const { data: urlData } = supabase.storage
            .from("shared-images")
            .getPublicUrl(filename);

        return res.status(200).json({
            success: true,
            url: urlData.publicUrl,
            filename: filename
        });

    } catch (error) {
        console.error("Upload error:", error);
        return res.status(500).json({ error: error.message || "An error occurred" });
    }
}
