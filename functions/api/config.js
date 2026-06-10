// API logic for System Configs and Auth
export async function onRequest(context) {
    const { request, env } = context;
    const db = env.DB;
    
    if (request.method === "OPTIONS") {
        return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST" } });
    }

    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.endsWith("/api/config/login")) {
        const body = await request.json();
        const storedUser = await db.prepare("SELECT value FROM system_configs WHERE key = 'admin_username'").first();
        const storedPass = await db.prepare("SELECT value FROM system_configs WHERE key = 'admin_password'").first();
        
        if (body.username === storedUser.value && body.password === storedPass.value) {
            // Generate JWT
            const secretRes = await db.prepare("SELECT value FROM system_configs WHERE key = 'jwt_secret'").first();
            const secret = secretRes.value;
            
            const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
            const payload = btoa(JSON.stringify({ admin: true, exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) }));
            
            const encoder = new TextEncoder();
            const key = await crypto.subtle.importKey(
                'raw', encoder.encode(secret),
                { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
            );
            const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(header + '.' + payload));
            const validSigB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
            
            const token = `${header}.${payload}.${validSigB64}`;
            
            return new Response(JSON.stringify({ success: true, token }), { headers: { "Content-Type": "application/json" }});
        }
        return new Response(JSON.stringify({ success: false, error: "Invalid credentials" }), { status: 401 });
    }

    // Require Auth for subsequent configs
    const authHeader = request.headers.get("Authorization");
    if (!authHeader) return new Response("Unauthorized", { status: 401 });

    if (request.method === "GET") {
        // Return metrics, relays, and configs (Masking secret and passwords)
        const relays = await db.prepare("SELECT * FROM relay_nodes").all();
        const configsRaw = await db.prepare("SELECT * FROM system_configs").all();
        
        const configs = {};
        for(const row of configsRaw.results) {
            if (row.key !== 'jwt_secret' && row.key !== 'admin_password') {
                configs[row.key] = row.value;
            }
        }
        
        const metrics = {
            total_bandwidth_bytes: await db.prepare("SELECT SUM(uploaded_bytes + downloaded_bytes) as total FROM users").first('total') || 0,
            active_users: await db.prepare("SELECT COUNT(*) as c FROM users WHERE is_active = 1").first('c') || 0
        };

        return new Response(JSON.stringify({ relays: relays.results, configs, metrics }), { status: 200 });
    }

    if (request.method === "POST") {
        const body = await request.json();
        if (body.action === "update_relay") {
            await db.prepare("UPDATE relay_nodes SET tag = ?, is_active = ?, priority = ? WHERE id = ?")
              .bind(body.tag, body.is_active ? 1 : 0, body.priority, body.id).run();
        } else if (body.action === "add_relay") {
             await db.prepare("INSERT INTO relay_nodes (name, ip_address, port, country_code, tag) VALUES (?, ?, ?, ?, ?)")
                .bind(body.name, body.ip_address, body.port, body.country_code, body.tag).run();
        } else if (body.action === "trigger_panic") {
            const current = await db.prepare("SELECT value FROM system_configs WHERE key = 'panic_mode'").first('value');
            const newStatus = current === 'true' ? 'false' : 'true';
            await db.prepare("UPDATE system_configs SET value = ? WHERE key = 'panic_mode'").bind(newStatus).run();
            return new Response(JSON.stringify({ success: true, panic_mode: newStatus }));
        }

        return new Response(JSON.stringify({ success: true }));
    }

    return new Response("Method Not Allowed", { status: 405 });
}
