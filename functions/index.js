export async function onRequest(context) {
    const { request, env } = context;
    const db = env.DB;

    // Detect user agent for subscription injection
    const ua = (request.headers.get("User-Agent") || "").toLowerCase();
    const isBrowser = ua.includes("mozilla") || ua.includes("chrome") || ua.includes("safari"); 

    if (isBrowser) {
        // Redirect browser clients cleanly to the dashboard UI layout built in /src/index.html
        return Response.redirect(new URL("/index.html", request.url), 302);
    }

    const url = new URL(request.url);
    const hostName = url.hostname;
    
    // Check if the user requests a subscription profile by UUID or name
    const requestedIdent = url.pathname.replace(/^\/+/, ""); 
    
    if (!requestedIdent) {
        return new Response("Invalid Profile", { status: 400 });
    }

    // Authenticate Against Cloudflare D1
    let profileQuery = "SELECT * FROM users WHERE uuid = ? AND is_active = 1";
    let dbUser = null;
    if (db) {
        dbUser = await db.prepare(profileQuery).bind(requestedIdent).first();
    }

    if (!dbUser) {
        return new Response("Not Authorized or Profile Terminated", { status: 401 });
    }

    // Build standard Base64 URI subscription
    const rawUri = buildTargetUri(dbUser.uuid, dbUser.username, hostName);

    // Profile Rules formatting (Vless base64 is default)
    if (ua.includes("clash") || ua.includes("meta")) {
        return new Response("yaml clash structures pending expansion", { status: 200 }); // Scaled out for brevity
    } else if (ua.includes("sing-box")) {
        return new Response("json sing-box rules pending expansion", { status: 200 }); 
    }

    return new Response(btoa(rawUri), { 
        headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
}

function buildTargetUri(uuid, name, host) {
    const port = "443";
    const sec = "tls";
    // Point the path directly to the `functions/stream.js` engine route
    const path = encodeURI("/stream"); 
    
    return \`vless://\${uuid}@\${host}:\${port}?encryption=none&security=\${sec}&sni=\${host}&fp=chrome&type=ws&host=\${host}&path=\${path}#\${name}\`;
}
