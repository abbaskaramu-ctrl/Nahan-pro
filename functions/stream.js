import { connect } from "cloudflare:sockets";

const AI_SINKHOLE_DOMAINS = ["openai", "anthropic", "claude"]; // Partial string match

async function getSysConfig(db, key) {
    if (!db) return null;
    const res = await db.prepare("SELECT value FROM system_configs WHERE key = ?").bind(key).first();
    return res ? res.value : null;
}

export async function onRequest(context) {
    const { request, env } = context;

    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
        return new Response("Expected Protocol Upgrade", { status: 426 });
    }

    const { DB } = env;
    
    // Check Global Panic State
    const panicMode = await getSysConfig(DB, 'panic_mode');
    if (panicMode === 'true') {
        return new Response(null, { status: 503, statusText: "Service Unavailable - Network Lock Active" });
    }

    const [client, webSocket] = Object.values(new WebSocketPair());
    webSocket.accept();
    webSocket.binaryType = "arraybuffer";

    let remoteSocket = null;
    let dataWriter = null;
    let isInit = true;
    let activeClientHash = null;

    webSocket.addEventListener("message", async (event) => {
        try {
            if (isInit) {
                isInit = false;
                
                // --- VLESS/Protocol Header Parse ---
                const bufferData = event.data;
                const view = new Uint8Array(bufferData);
                
                // Assume standard Vless identifier check (0x00)
                if (view[0] !== 0x00) {
                    webSocket.close();
                    return;
                }

                // 16-byte UUID extract
                const clientHashArray = Array.from(view.slice(1, 17)).map(b => b.toString(16).padStart(2, '0'));
                const clientHash = clientHashArray.join('');
                const canonicalUuid = `${clientHash.slice(0,8)}-${clientHash.slice(8,12)}-${clientHash.slice(12,16)}-${clientHash.slice(16,20)}-${clientHash.slice(20,32)}`;
                
                // D1 SQLite Validation Validation 
                const dbUser = DB ? await DB.prepare("SELECT * FROM users WHERE uuid = ? AND is_active = 1").bind(canonicalUuid).first() : null;
                
                if (!dbUser) {
                    // Profile validation failure
                    webSocket.close();
                    return;
                }
                
                // Enforce traffic thresholds safely preventing limits over D1 free bounds
                const totalUsed = dbUser.uploaded_bytes + dbUser.downloaded_bytes;
                if (dbUser.limit_bytes > 0 && totalUsed >= dbUser.limit_bytes) {
                     webSocket.close();
                     return;
                }
                
                activeClientHash = canonicalUuid;

                // Send Vless protocol confirmation chunk back to client
                webSocket.send(new Uint8Array([0, 0]));

                // Deep parse destination
                let targetPort = 443;
                let targetAddr = "www.google.com";

                const optLen = view[17];
                const pPos = 18 + optLen + 1;
                targetPort = new DataView(bufferData.slice(pPos, pPos + 2)).getUint16(0);
                const aType = view[pPos + 2];
                let vPos = pPos + 3;
                let aLen = 0;
    
                if (aType === 1) { 
                    aLen = 4; targetAddr = view.slice(vPos, vPos + aLen).join("."); 
                } else if (aType === 2) { 
                    aLen = view[vPos]; vPos++; targetAddr = new TextDecoder().decode(view.slice(vPos, vPos + aLen)); 
                } else if (aType === 3) { 
                    aLen = 16; const dv = new DataView(bufferData.slice(vPos, vPos + aLen)); targetAddr = Array.from({ length: 8 }, (_, i) => dv.getUint16(i * 2).toString(16)).join(":"); 
                }
                let offset = vPos + aLen;

                // --- 🌟 Autonomous Relay Routing Layer ---
                let connectAddr = targetAddr;
                let connectPort = targetPort;
                let requiresUSNode = AI_SINKHOLE_DOMAINS.some(domain => typeof targetAddr === 'string' && targetAddr.toLowerCase().includes(domain));
                
                if (requiresUSNode && DB) {
                     const usRelay = await DB.prepare("SELECT * FROM relay_nodes WHERE country_code = 'US' AND is_active = 1 ORDER BY priority DESC LIMIT 1").first();
                     if (usRelay) {
                         connectAddr = usRelay.ip_address;
                         connectPort = usRelay.port;
                     }
                }

                // Native Cloudflare proxying
                remoteSocket = connect({ hostname: connectAddr, port: connectPort });
                await remoteSocket.opened;

                dataWriter = remoteSocket.writable.getWriter();
                if (offset < bufferData.byteLength) {
                    const chunk = bufferData.slice(offset);
                    // Accurately measure upload bytes sent mapping to DB
                    updateMetrics(DB, activeClientHash, chunk.byteLength, 0);
                    await dataWriter.write(chunk);
                }

                // Set up the precise downstream measurement array buffer pipe
                remoteSocket.readable.pipeTo(new WritableStream({
                    async write(chunk) {
                        try {
                            webSocket.send(chunk);
                            updateMetrics(DB, activeClientHash, 0, chunk.byteLength);
                        } catch(e) { }
                    }
                })).catch(()=>{});

            } else if (dataWriter) {
                // Secondary stream pipeline chunks
                updateMetrics(DB, activeClientHash, event.data.byteLength, 0);
                await dataWriter.write(event.data);
            }
        } catch (err) { 
            webSocket.close(); 
        }
    });

    return new Response(null, { status: 101, webSocket: client });
}

// Byte queue to avoid overwhelming Free Tier D1 IO writes (batch updating)
let batchedMetrics = new Map();
let metricSyncTimer = null;

function updateMetrics(DB, uuid, upByte, downByte) {
    if (!uuid) return;
    let b = batchedMetrics.get(uuid) || { up: 0, down: 0 };
    b.up += upByte;
    b.down += downByte;
    batchedMetrics.set(uuid, b);

    if (!metricSyncTimer) {
        // Sync to D1 Database every 10 seconds asynchronously to preserve fast edge stream runtime limits
        metricSyncTimer = setTimeout(async () => {
            const batch = Array.from(batchedMetrics.entries());
            batchedMetrics.clear();
            metricSyncTimer = null;
            
            if (!DB) return;
            for (let [uid, metrics] of batch) {
                try {
                    await DB.prepare("UPDATE users SET uploaded_bytes = uploaded_bytes + ?, downloaded_bytes = downloaded_bytes + ? WHERE uuid = ?")
                            .bind(metrics.up, metrics.down, uid).run();
                } catch(e) { /* ignore to prevent stalling stream */ }
            }
        }, 10000);
    }
}
