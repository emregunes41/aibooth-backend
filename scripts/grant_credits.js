import { createClient } from "@supabase/supabase-js";
import 'dotenv/config';

// Initialize Supabase client
// MUST use SERVICE_ROLE_KEY for admin operations
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
    console.error("Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});

async function main() {
    // Parse arguments
    const args = process.argv.slice(2);
    const emailArg = args.find(arg => arg.startsWith('--email='));
    const amountArg = args.find(arg => arg.startsWith('--amount='));

    if (!emailArg) {
        console.log("Usage: node scripts/grant_credits.js --email=user@example.com [--amount=100]");
        console.log("\nAvailable Users:");
        await listUsers();
        return;
    }

    const email = emailArg.split('=')[1];
    const amount = amountArg ? parseInt(amountArg.split('=')[1]) : 100;

    console.log(`Looking for user: ${email}...`);

    // Find user ID from Auth
    const { data: { users }, error: authError } = await supabase.auth.admin.listUsers();

    if (authError) {
        console.error("Auth error:", authError);
        return;
    }

    const user = users.find(u => u.email === email);

    if (!user) {
        console.error(`User not found: ${email}`);
        return;
    }

    console.log(`Found user ID: ${user.id}`);

    // Update their credits
    // First get current
    const { data: currentCredit, error: fetchError } = await supabase
        .from('credits')
        .select('balance')
        .eq('user_id', user.id)
        .single();

    let newBalance = amount;
    if (currentCredit) {
        console.log(`Current balance: ${currentCredit.balance}`);
        newBalance = currentCredit.balance + amount;
    } else {
        console.log("No existing credit record. Creating new one.");
        // Insert if not exists (though generate.js assumes it exists)
        const { error: insertError } = await supabase
            .from('credits')
            .insert({ user_id: user.id, balance: amount });

        if (insertError) {
            console.error("Insert error:", insertError);
            return;
        }
        console.log(`Created credit record with ${amount} credits.`);
        return;
    }

    // Update
    const { error: updateError } = await supabase
        .from('credits')
        .update({
            balance: newBalance,
            updated_at: new Date().toISOString()
        })
        .eq('user_id', user.id);

    if (updateError) {
        console.error("Update error:", updateError);
    } else {
        console.log(`✅ Successfully added ${amount} credits!`);
        console.log(`New Balance: ${newBalance}`);
    }
}

async function listUsers() {
    const { data: { users }, error } = await supabase.auth.admin.listUsers();
    if (error) {
        console.error("Error listing users:", error);
        return;
    }

    for (const u of users) {
        // Fetch credits for display
        const { data: credit } = await supabase
            .from('credits')
            .select('balance')
            .eq('user_id', u.id)
            .single();

        console.log(`- ${u.email} (ID: ${u.id.substring(0, 8)}...) - Credits: ${credit?.balance || 0}`);
    }
}

main().catch(console.error);
