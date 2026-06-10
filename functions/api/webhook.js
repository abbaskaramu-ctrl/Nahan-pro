export async function onRequestPost({ request, env }) {
    const db = env.DB;
    let token = await getSysConfig(db, 'tg_token');
    
    // Security check: Ignore if no token set or not matching secret path if using one
    if (!token) return new Response("Telegram integration disabled", { status: 200 });

    try {
        const update = await request.json();
        if (update.callback_query) {
            await handleCallbackQuery(update.callback_query, db, token);
        } else if (update.message) {
            await handleMessage(update.message, db, token);
        }
    } catch (e) {
        // Don't fail the webhook processing itself for minor logic issues
        console.error("Webhook processing error: ", e);
    }
    
    return new Response("OK", { status: 200 });
}

async function getSysConfig(db, key) {
    const res = await db.prepare("SELECT value FROM system_configs WHERE key = ?").bind(key).first();
    return res ? res.value : null;
}

// Full interactive Callback Query Matrix
async function handleCallbackQuery(cb, db, token) {
    const chatId = cb.message.chat.id;
    const msgId = cb.message.message_id;
    const data = cb.data;

    let text = "Command executed";
    let kb = [];

    if (data === "menu_main") {
        text = "🎛 **Nahan Super Panel - Admin Dashboard**\nSelect an operation below:";
        kb = [
            [{ text: "👥 User Manager", callback_data: "menu_users:0" }, { text: "🌐 Smart Relays", callback_data: "menu_relays" }],
            [{ text: "🛡️ Panic/Security", callback_data: "menu_panic" }, { text: "⚙️ System Configs", callback_data: "menu_sys" }]
        ];
    } else if (data.startsWith("menu_users:")) {
        const page = parseInt(data.split(":")[1]);
        const offset = page * 5;
        const { results } = await db.prepare("SELECT * FROM users ORDER BY id DESC LIMIT 5 OFFSET ?").bind(offset).all();
        const countRes = await db.prepare("SELECT COUNT(*) as c FROM users").first();
        const total = countRes.c;

        text = `👥 **User Manager** (Total: ${total})\nPage ${page + 1}`;
        
        results.forEach(u => {
            const status = u.is_active ? "🟢" : "🔴";
            kb.push([{ text: `${status} ${u.username}`, callback_data: `user_action:${u.id}` }]);
        });

        const navRow = [];
        if (page > 0) navRow.push({ text: "⬅️ Prev", callback_data: `menu_users:${page - 1}` });
        if (offset + 5 < total) navRow.push({ text: "Next ➡️", callback_data: `menu_users:${page + 1}` });
        if (navRow.length > 0) kb.push(navRow);
        
        kb.push([{ text: "🔙 Main Menu", callback_data: "menu_main" }]);
    } else if (data.startsWith("user_action:")) {
        const uid = data.split(":")[1];
        const u = await db.prepare("SELECT * FROM users WHERE id = ?").bind(uid).first();
        if (u) {
            const gbUsed = ((u.uploaded_bytes + u.downloaded_bytes) / 1073741824).toFixed(2);
            text = `👤 **User:** ${u.username}\n🔑 **UUID:** \`${u.uuid}\`\n📊 **Traffic Consumed:** ${gbUsed} GB\n🚥 **Status:** ${u.is_active ? 'Active' : 'Suspended'}`;
            kb = [
                [{ text: u.is_active ? "🚫 Suspend User" : "✅ Activate User", callback_data: `user_toggle:${u.id}` }],
                [{ text: "🔄 Reset Bandwidth", callback_data: `user_reset:${u.id}` }, { text: "🗑️ Delete", callback_data: `user_delete:${u.id}` }],
                [{ text: "🔙 Back to Users", callback_data: "menu_users:0" }]
            ];
        }
    } else if (data.startsWith("user_toggle:")) {
        const uid = data.split(":")[1];
        const u = await db.prepare("SELECT is_active FROM users WHERE id = ?").bind(uid).first();
        await db.prepare("UPDATE users SET is_active = ? WHERE id = ?").bind(u.is_active ? 0 : 1, uid).run();
        // Redirect to detail
        await answerCb(cb.id, "User status changed!", token);
        return handleCallbackQuery({ message: cb.message, data: `user_action:${uid}` }, db, token);
    } else if (data.startsWith("user_reset:")) {
        const uid = data.split(":")[1];
        await db.prepare("UPDATE users SET uploaded_bytes = 0, downloaded_bytes = 0 WHERE id = ?").bind(uid).run();
        await answerCb(cb.id, "Bandwidth reset to 0!", token);
        return handleCallbackQuery({ message: cb.message, data: `user_action:${uid}` }, db, token);
    } else if (data.startsWith("user_delete:")) {
        const uid = data.split(":")[1];
        await db.prepare("DELETE FROM users WHERE id = ?").bind(uid).run();
        await answerCb(cb.id, "User deleted!", token);
        return handleCallbackQuery({ message: cb.message, data: "menu_users:0" }, db, token);
    } else if (data === "menu_relays") {
        const { results } = await db.prepare("SELECT * FROM relay_nodes").all();
        text = "🌐 **Smart Relays Configuration**";
        results.forEach(r => {
            const flag = r.country_code === 'US' ? '🇺🇸' : '🌐';
            kb.push([{ text: `${r.is_active?'🟢':'🔴'} ${flag} ${r.name}`, callback_data: `relay_toggle:${r.id}` }]);
        });
        kb.push([{ text: "🔙 Main Menu", callback_data: "menu_main" }]);
    } else if (data.startsWith("relay_toggle:")) {
        const rid = data.split(":")[1];
        const r = await db.prepare("SELECT is_active FROM relay_nodes WHERE id = ?").bind(rid).first();
        await db.prepare("UPDATE relay_nodes SET is_active = ? WHERE id = ?").bind(r.is_active ? 0 : 1, rid).run();
        await answerCb(cb.id, "Relay matrix updated", token);
        return handleCallbackQuery({ message: cb.message, data: "menu_relays" }, db, token);
    } else if (data === "menu_panic") {
        const panic = await getSysConfig(db, 'panic_mode');
        const isActive = panic === 'true';
        text = `🛡️ **System Status & Panic Control**\nCurrent Panic Mode: **${isActive ? 'ACTIVATED' : 'Disabled'}**\n\n*Panic mode drops all incoming websocket streams and locks network egress.*`;
        kb = [
            [{ text: isActive ? "🟢 Deactivate Panic" : "🚨 ACTIVATE PANIC", callback_data: "toggle_panic" }],
            [{ text: "🔙 Main Menu", callback_data: "menu_main" }]
        ];
    } else if (data === "toggle_panic") {
        const panic = await getSysConfig(db, 'panic_mode');
        const newStatus = panic === 'true' ? 'false' : 'true';
        await db.prepare("UPDATE system_configs SET value = ? WHERE key = 'panic_mode'").bind(newStatus).run();
        await answerCb(cb.id, `Panic mode ${newStatus === 'true' ? 'ACTIVATED' : 'Deactivated'}`, token);
        return handleCallbackQuery({ message: cb.message, data: "menu_panic" }, db, token);
    }

    if (kb.length > 0) {
        await editMessage(chatId, msgId, text, kb, token);
    }
    await answerCb(cb.id, "", token);
}

// Banned text processing (Only commands like /start /admin)
async function handleMessage(msg, db, token) {
    if (msg.text && (msg.text === "/start" || msg.text === "/admin")) {
        const kb = [
            [{ text: "Enter Interactive Super Panel", callback_data: "menu_main" }]
        ];
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: msg.chat.id,
                text: "✨ Welcome to Nahan Embedded Router.",
                reply_markup: { inline_keyboard: kb }
            })
        });
    }
}

async function editMessage(chatId, msgId, text, kb, token) {
    await fetch(`https://api.telegram.org/bot${token}/editMessageText\`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId, message_id: msgId, text: text,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: kb }
        })
    });
}

async function answerCb(cbId, text, token) {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: cbId, text: text })
    });
}
