import "./css/style.css"; // Ensure standard vite environment parses if applied, but for Pages we just run natively.

document.addEventListener("DOMContentLoaded", () => {
    // Check initial state
    const token = localStorage.getItem("nahan_admin_token");
    if (token) {
        document.getElementById("login-screen").classList.add("hidden");
        document.getElementById("login-screen").style.display = "none";
        fetchMetrics();
        fetchUsers();
    } else {
        document.getElementById("login-screen").style.display = "flex";
    }

    document.querySelectorAll(".nav-item").forEach(item => {
        item.addEventListener("click", () => {
            document.querySelectorAll(".nav-item").forEach(i => i.classList.remove("active"));
            item.classList.add("active");
            
            document.querySelectorAll(".view-section").forEach(sec => sec.classList.remove("active"));
            const target = item.getAttribute("data-target");
            document.getElementById(target).classList.add("active");
        });
    });
});

async function apiCall(path, method = "GET", body = null) {
    const token = localStorage.getItem("nahan_admin_token");
    const headers = {
        "Content-Type": "application/json",
        ...(token && { "Authorization": \`Bearer \${token}\` })
    };
    
    let options = { method, headers };
    if (body) options.body = JSON.stringify(body);
    
    const res = await fetch(\`/api\${path}\`, options);
    if (res.status === 401) {
        logout();
        throw new Error("Unauthorized");
    }
    return res.json();
}

window.doLogin = async () => {
    const user = document.getElementById("admin-user").value;
    const pass = document.getElementById("admin-pass").value;
    
    try {
        const data = await apiCall("/config/login", "POST", { username: user, password: pass });
        if (data.success) {
            localStorage.setItem("nahan_admin_token", data.token);
            document.getElementById("login-screen").style.display = "none";
            fetchMetrics();
            fetchUsers();
        } else {
            alert("Invalid Credentials");
        }
    } catch(e) {
        alert("Server error or unauthorized.");
    }
}

window.logout = () => {
    localStorage.removeItem("nahan_admin_token");
    location.reload();
}

async function fetchMetrics() {
    const data = await apiCall("/config");
    if (!data) return;
    
    document.getElementById("stat-users").innerText = data.metrics.active_users;
    document.getElementById("stat-traffic").innerText = (data.metrics.total_bandwidth_bytes / (1024 ** 3)).toFixed(2) + " GB";
    
    const pBtn = document.getElementById("panic-btn");
    pBtn.className = data.configs.panic_mode === 'true' ? "btn btn-danger" : "btn btn-success";
    pBtn.innerText = data.configs.panic_mode === 'true' ? "🚨 Panic Active (Disable)" : "🟢 Secure Status (Trigger Panic)";
}

async function fetchUsers() {
    const data = await apiCall("/users");
    const tbody = document.getElementById("users-tbody");
    tbody.innerHTML = "";
    
    if (data.users && data.users.length > 0) {
        data.users.forEach(u => {
            const tr = document.createElement("tr");
            const usedGb = ((u.uploaded_bytes + u.downloaded_bytes) / (1024 ** 3)).toFixed(2);
            tr.innerHTML = \`
                <td><span class="badge \${u.is_active ? 'badge-active' : 'badge-paused'}">\${u.is_active ? 'Active' : 'Suspended'}</span> \${u.username}</td>
                <td><code style="font-size: 0.75rem; color: var(--text-muted);">\${u.uuid}</code></td>
                <td style="font-family: monospace;">\${usedGb} GB / \${u.limit_bytes ? (u.limit_bytes / (1024**3)).toFixed(2) + ' GB' : '∞'}</td>
                <td>
                    <button class="btn" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;" onclick="copySub('\${u.uuid}', '\${u.username}')">Copy Info & QR</button>
                    <button class="btn" style="padding: 0.3rem 0.6rem; background: rgba(239, 68, 68, 0.1); color: var(--danger); border-color: rgba(239, 68, 68, 0.2);" onclick="deleteUser('\${u.uuid}')">Delete</button>
                </td>
            \`;
            tbody.appendChild(tr);
        });
    } else {
        tbody.innerHTML = "<tr><td colspan='4' style='text-align:center;'>No users provisioned yet.</td></tr>";
    }
}

window.togglePanic = async () => {
    await apiCall("/config", "POST", { action: "trigger_panic" });
    fetchMetrics();
}

window.addUser = async () => {
    const uname = document.getElementById("new-user-name").value;
    const limitGb = parseFloat(document.getElementById("new-user-limit").value) || 0;
    
    if (!uname) return alert("Requires username");
    
    await apiCall("/users", "POST", { 
        username: uname, 
        limit_bytes: limitGb * (1024 ** 3) 
    });
    
    document.getElementById("new-user-name").value = "";
    document.getElementById("new-user-limit").value = "";
    fetchUsers();
}

window.deleteUser = async (uuid) => {
    if (!confirm("Are you sure you want to completely erase this user geometry from D1 matrix?")) return;
    await apiCall(\`/users?uuid=\${uuid}\`, "DELETE");
    fetchUsers();
}

window.copySub = (uuid, name) => {
    const route = location.hostname;
    // Format Alpha (V-Core representation)
    const uri = \`vless://\${uuid}@\${route}:443?encryption=none&security=tls&sni=\${route}&fp=chrome&type=ws&host=\${route}&path=/stream#\${name}\`;
    
    navigator.clipboard.writeText(uri);
    alert(\`V-Core profile copied to clipboard!\\n\\nURI:\\n\${uri}\`);
    
    // Render Quick QR
    const dm = document.getElementById("qr-modal");
    dm.classList.add("open");
    
    // Tiny native 2D canvas QR (fallback to external API if native renderer omitted for code golf, but sticking to constraints:)
    document.getElementById("qr-canvas-container").innerHTML = \`<img src="https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=\${encodeURIComponent(uri)}" alt="QR">\`;
}

window.closeQR = () => {
    document.getElementById("qr-modal").classList.remove("open");
}
