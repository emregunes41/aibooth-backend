import { createClient } from "@supabase/supabase-js";

// Initialize Supabase client with service role for admin operations
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

    const { action, email, password } = req.body;

    try {
        switch (action) {
            case "register": {
                if (!email || !password) {
                    return res.status(400).json({ error: "Email and password required" });
                }

                const { data, error } = await supabase.auth.admin.createUser({
                    email,
                    password,
                    email_confirm: true,
                });

                if (error) {
                    return res.status(400).json({ error: error.message });
                }

                return res.status(200).json({
                    success: true,
                    message: "Kayıt başarılı! Giriş yapabilirsiniz.",
                    user: { id: data.user.id, email: data.user.email },
                });
            }

            case "login": {
                if (!email || !password) {
                    return res.status(400).json({ error: "Email and password required" });
                }

                // Create a client-side supabase for login
                const anonSupabase = createClient(
                    process.env.SUPABASE_URL,
                    process.env.SUPABASE_ANON_KEY
                );

                const { data, error } = await anonSupabase.auth.signInWithPassword({
                    email,
                    password,
                });

                if (error) {
                    return res.status(401).json({ error: "Geçersiz e-posta veya şifre" });
                }

                // Get credit balance
                const { data: creditData } = await supabase
                    .from("credits")
                    .select("balance")
                    .eq("user_id", data.user.id)
                    .single();

                return res.status(200).json({
                    success: true,
                    user: {
                        id: data.user.id,
                        email: data.user.email,
                    },
                    session: {
                        access_token: data.session.access_token,
                        refresh_token: data.session.refresh_token,
                    },
                    credits: creditData?.balance || 0,
                });
            }

            case "get_credits": {
                const authHeader = req.headers.authorization;
                if (!authHeader) {
                    return res.status(401).json({ error: "No authorization header" });
                }

                const token = authHeader.replace("Bearer ", "");

                // Verify token
                const anonSupabase = createClient(
                    process.env.SUPABASE_URL,
                    process.env.SUPABASE_ANON_KEY
                );

                const { data: userData, error: userError } = await anonSupabase.auth.getUser(token);

                if (userError || !userData.user) {
                    return res.status(401).json({ error: "Invalid token" });
                }

                const { data: creditData } = await supabase
                    .from("credits")
                    .select("balance")
                    .eq("user_id", userData.user.id)
                    .single();

                return res.status(200).json({
                    credits: creditData?.balance || 0,
                });
            }

            case "add_credits": {
                const authHeader = req.headers.authorization;
                if (!authHeader) {
                    return res.status(401).json({ error: "No authorization header" });
                }

                const token = authHeader.replace("Bearer ", "");
                const { credits, transactionId } = req.body;

                if (!credits || credits <= 0) {
                    return res.status(400).json({ error: "Invalid credit amount" });
                }

                // Verify token
                const anonSupabase = createClient(
                    process.env.SUPABASE_URL,
                    process.env.SUPABASE_ANON_KEY
                );

                const { data: userData, error: userError } = await anonSupabase.auth.getUser(token);

                if (userError || !userData.user) {
                    return res.status(401).json({ error: "Invalid token" });
                }

                // Check if transaction already processed (prevent double-add)
                if (transactionId) {
                    const { data: existingTx } = await supabase
                        .from("transactions")
                        .select("id")
                        .eq("transaction_id", transactionId)
                        .single();

                    if (existingTx) {
                        // Already processed, return current balance
                        const { data: creditData } = await supabase
                            .from("credits")
                            .select("balance")
                            .eq("user_id", userData.user.id)
                            .single();

                        return res.status(200).json({
                            success: true,
                            message: "Transaction already processed",
                            credits: creditData?.balance || 0,
                        });
                    }

                    // Record transaction
                    await supabase.from("transactions").insert({
                        user_id: userData.user.id,
                        transaction_id: transactionId,
                        credits_added: credits,
                        created_at: new Date().toISOString(),
                    });
                }

                // Upsert credits
                const { data: creditData } = await supabase
                    .from("credits")
                    .select("balance")
                    .eq("user_id", userData.user.id)
                    .single();

                const currentBalance = creditData?.balance || 0;
                const newBalance = currentBalance + credits;

                await supabase.from("credits").upsert({
                    user_id: userData.user.id,
                    balance: newBalance,
                    updated_at: new Date().toISOString(),
                });

                console.log(`Added ${credits} credits to user ${userData.user.id}. New balance: ${newBalance}`);

                return res.status(200).json({
                    success: true,
                    credits: newBalance,
                });
            }

            default:
                return res.status(400).json({ error: "Invalid action" });
        }
    } catch (error) {
        console.error("Auth error:", error);
        return res.status(500).json({ error: error.message });
    }
}
