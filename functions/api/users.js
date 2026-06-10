// Helper: Verify JWT and setup DB connection for all requests
async function authorize(request, env) {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
    const token = authHeader.split(" ")[1];
    
    // Simplistic JWT-like HMAC verification (for demonstration and zero-dependency constraint)
    try {
        const secret = await getSysConfig(env.DB, 'jwt_secret');
        const [headerB64, payloadB64, sigB64] = token.split('.');
        
        // Compute HMAC SHA-256 for validation
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
            'raw', encoder.encode(secret),
            { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        );
        const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(headerB64 + '.' + payloadB64));
        const validSigB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
        
        if (sigB64 !== validSigB64) return null;
        
        const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
        if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
        return payload;
    } catch (e) {
        return null; // Invalid token
    }
}

async function getSysConfig(db, key) {
    const res = await db.prepare("SELECT value FROM system_configs WHERE key = ?").bind(key).first();
    return res ? res.value : null;
}

export async function onRequest(context) {
    const { request, env } = context;
    const db = env.DB;
    
    if (!db) {
        return new Response("Missing DB binding", { status: 500 });
    }

    if (request.method === "OPTIONS") {
        return new Response(null, {
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Authorization, Content-Type",
                "Access-Control-Allow-Methods": "GET, POST, DELETE, PUT"
            }
        });
    }

    const payload = await authorize(request, env);
    if (!payload && request.method !== "POST") { // Exception for initial login to an endpoint if it were here, but login is in config
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    const url = new URL(request.url);

    try {
        if (request.method === "GET") {
            const { results } = await db.prepare("SELECT * FROM users ORDER BY id DESC").all();
            return new Response(JSON.stringify({ users: results }), { headers: { "Content-Type": "application/json" } });
        }

        if (request.method === "POST") {
            const data = await request.json();
            const uuid = crypto.randomUUID();
            await db.prepare(`
                INSERT INTO users (uuid, username, email, limit_bytes, expires_at)
                VALUES (?, ?, ?, ?, ?)
            \`).bind(
                uuid, data.username, data.email || null, 
                data.limit_bytes || 0, data.expires_at || null
            ).run();
            return new Response(JSON.stringify({ success: true, uuid }), { status: 201 });
        }

        if (request.method === "PUT") {
            const data = await request.json();
            await db.prepare(\`
                UPDATE users SET username = ?, limit_bytes = ?, is_active = ? WHERE uuid = ?
            \`).bind(
                data.username, data.limit_bytes, data.is_active ? 1 : 0, data.uuid
            ).run();
            return new Response(JSON.stringify({ success: true }));
        }

        if (request.method === "DELETE") {
            const uuid = url.searchParams.get("uuid");
            if (!uuid) return new Response("Missing UUID", { status: 400 });
            await db.prepare("DELETE FROM users WHERE uuid = ?").bind(uuid).run();
            return new Response(JSON.stringify({ success: true }));
        }

    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }

    return new Response("Method not allowed", { status: 405 });
}
