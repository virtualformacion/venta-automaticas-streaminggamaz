const DB_ENDPOINT = "/.netlify/functions/db";

// Si true: el cliente verá email/contraseña también en compras por perfil.
// Si false: el cliente verá solo Nombre del perfil + Código.
const SHOW_PROFILE_CREDENTIALS = true;



// ✅ Texto estándar de garantía para compras por PERFIL (Netflix/Disney/etc.)
const WARRANTY_PROFILE_TEXT = `🍿 Pruebas y me cuentas cualquier novedad😊

CONDICIONES
- 🚫NO cambiar nombres
- 🚫NO cambiar imagen 
- 🚫NO cambiar Pin ni contraseña 
- 🚫NO añadir miembro extra
- 📲1 solo dispositivo por pantalla comprada.

⚠️Si incumples alguna de estas condiciones, pierdes la cuenta sin derecho a garantía o devolución de dinero.⚠️

La duración de la cuenta es de 27 a 28 días. Por cada mes adquirido.`;

// ✅ Mensaje estándar SOLO para Netflix COMPLETA (full): inserta email/contraseña vendidos
function buildNetflixFullMessage(email, password) {
  return `Netflix Premium
Email: ${email}
Contraseña: ${password}
Perfiles asignados:
-<<<

Perfil #1,Pin:8727 🔐
Perfil #2,Pin:1994 🔐
Perfil #3,Pin:2020 🔐
Perfil #4,Pin:2018 🔐
Perfil #5,Pin:2190 🔐

🍿 Pruebas y me cuentas cualquier novedad😊

CONDICIONES
- 🚫NO cambiar nombres
- 🚫NO cambiar imagen 
- 🚫NO cambiar Pin ni contraseña 
- 🚫NO añadir miembro extra
- 📲1 solo dispositivo por pantalla comprada.

⚠️Si incumples alguna de estas condiciones, pierdes la cuenta sin derecho a garantía o devolución de dinero.⚠️

La duración de la cuenta es de 27 a 28 días. Por cada mes adquirido.

PAGINA CODIGOS HOGAR
🌐https://code-gamaz.netlify.app`;
}

/* Helpers */
const $ = (sel) => document.querySelector(sel);
const nowISO = () => new Date().toISOString();
const toCOP = (n) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n || 0);
const toUSD = (n) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n || 0);
const todayYMD = () => new Date().toISOString().slice(0, 10);

function isExpired(expiresAtYMD) {
  if (!expiresAtYMD) return false;
  return todayYMD() > expiresAtYMD;
}
function uuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return "xxxxxxxyxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/* API */
async function loadDB() {
  const r = await fetch(DB_ENDPOINT);
  if (!r.ok) throw new Error(await r.text());
  return await r.json(); // { sha, data }
}
async function saveDB(data, message) {
  const r = await fetch(DB_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data, message })
  });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

/* FX */
async function getUsdCopRate() {
  const r = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
  if (!r.ok) throw new Error("No se pudo obtener la tasa USD/COP");
  const j = await r.json();
  const rate = j?.rates?.COP;
  if (!rate) throw new Error("Respuesta inválida de tasa USD/COP");
  return rate;
}

/* Session */
function setSession(obj) { localStorage.setItem("session", JSON.stringify(obj)); }
function getSession() { try { return JSON.parse(localStorage.getItem("session") || "null"); } catch { return null; } }
function clearSession() { localStorage.removeItem("session"); }

/* Stock */
function stockCount(product, db) {
  if (product.type === "full") {
    return product.inventory?.fullAccounts?.length || 0;
  }
  if (product.type === "profile") {
    const accounts = product.inventory?.profileAccounts || [];
    let total = 0;
    for (const acc of accounts) {
      for (const p of (acc.profiles || [])) total += p.available ? 1 : 0;
    }
    return total;
  }

if (product.type === "giftcard") {
  const arr = product.inventory?.giftcards || [];
  return arr.filter(gc => gc && gc.available).length;
}

  if (product.type === "bundle") {
    let possible = Infinity;
    for (const it of (product.bundle || [])) {
      const child = db.services.find(s => s.key === it.key);
      if (!child) return 0;
      const c = stockCount(child, db);
      possible = Math.min(possible, Math.floor(c / (it.qty || 1)));
    }
    return Number.isFinite(possible) ? possible : 0;
  }
  return 0;
}
function takeFullAccount(product) {
  const arr = product.inventory?.fullAccounts || [];
  if (!arr.length) return null;

  // Mantener el comportamiento actual: sale del stock disponible
  const soldAcc = arr.shift();

  // Guardar historial de vendidos SOLO para mostrar en el panel admin (stock agregado)
  const inv = product.inventory || (product.inventory = {});
  const soldArr = inv.fullAccountsSold || (inv.fullAccountsSold = []);
  soldArr.push({ ...soldAcc, soldAt: nowISO() });

  return soldAcc;
}
function takeProfile(product) {
  const accounts = product.inventory?.profileAccounts || [];
  for (const acc of accounts) {
    const prof = (acc.profiles || []).find(p => p.available);
    if (prof) {
      prof.available = false;
      // marca cuándo se vendió para poder limpiar stock vendido automáticamente
      prof.soldAt = nowISO();
      return { email: acc.email, password: acc.password, profile: prof.name, code: prof.code };
    }
  }
  return null;
}

function takeGiftcard(product) {
  const arr = product.inventory?.giftcards || [];
  const gc = arr.find(x => x && x.available);
  if (!gc) return null;

  gc.available = false;
  gc.soldAt = nowISO(); // <- esto habilita borrado automático a 2 días
  return { code: gc.code };
}


/* Limpieza automática (FASE 1)
   - Borra compras con más de 31 días
   - Borra perfiles vendidos del stock con más de 2 días (y elimina cuentas vacías)
*/
function autoCleanupData(dbData, opts = {}) {
  const MS_DAY = 24 * 60 * 60 * 1000;
  const purchasesDays = Number(opts.purchasesDays || 31);
  const soldStockDays = Number(opts.soldStockDays || 2);

  const now = Date.now();
  const cutoffPurch = now - purchasesDays * MS_DAY;
  const cutoffSold = now - soldStockDays * MS_DAY;

  let changed = false;

  // mapa códigoPerfil -> fechaVenta (purchasedAt)
  const soldByCode = {};
  for (const p of (dbData.purchases || [])) {
    const t = new Date(p.purchasedAt || 0).getTime();
    if (!Number.isFinite(t) || !t) continue;
    for (const it of (p.items || [])) {
      if (it.mode === "profile" && it.code) {
        // nos quedamos con la venta más reciente por código
        if (!soldByCode[it.code] || t > soldByCode[it.code]) soldByCode[it.code] = t;
      }
    }
  }

  // 1) compras > N días
  if (Array.isArray(dbData.purchases) && dbData.purchases.length) {
    const before = dbData.purchases.length;
    dbData.purchases = dbData.purchases.filter(p => {
      const t = new Date(p.purchasedAt || 0).getTime();
      if (!Number.isFinite(t) || !t) return true; // si no hay fecha válida, no borramos
      return t >= cutoffPurch;
    });
    if (dbData.purchases.length !== before) changed = true;
  }

  // 2) stock vendido (solo aplica a productos type=profile)
  if (Array.isArray(dbData.services)) {
    for (const prod of dbData.services) {
      if (prod?.type !== "profile") continue;

      const inv = prod.inventory || (prod.inventory = {});
      const accs = inv.profileAccounts || [];
      if (!Array.isArray(accs) || !accs.length) continue;

      const newAccs = [];
      for (const acc of accs) {
        const profs = Array.isArray(acc.profiles) ? acc.profiles : [];
        const kept = [];

        for (const pr of profs) {
          if (pr?.available) { kept.push(pr); continue; }

          // si no tiene soldAt pero sí tenemos histórico por código, lo asignamos
          if (!pr.soldAt && pr?.code && soldByCode[pr.code]) {
            pr.soldAt = new Date(soldByCode[pr.code]).toISOString();
            changed = true;
          }

          const soldT = pr.soldAt ? new Date(pr.soldAt).getTime() : NaN;
          // si está vendido y tiene fecha válida, lo borramos cuando pase el umbral
          if (Number.isFinite(soldT) && soldT < cutoffSold) {
            changed = true;
            continue; // eliminar perfil vendido antiguo
          }

          // si no hay fecha, lo conservamos para no borrar datos por error
          kept.push(pr);
        }

        if (kept.length !== profs.length) changed = true;

        // si ya no quedan perfiles en esta cuenta, elimina la cuenta completa
        if (kept.length > 0) {
          acc.profiles = kept;
          newAccs.push(acc);
        } else {
          changed = true;
        }
      }

      if (newAccs.length !== accs.length) {
        inv.profileAccounts = newAccs;
        changed = true;
      }
    }
  }

      // 3) stock vendido (giftcards)
    if (Array.isArray(dbData.services)) {
      for (const prod of dbData.services) {
        if (prod?.type !== "giftcard") continue;

        const inv = prod.inventory || (prod.inventory = {});
        const arr = inv.giftcards || [];
        if (!Array.isArray(arr) || !arr.length) continue;

        const kept = [];
        for (const gc of arr) {
          if (gc?.available) { kept.push(gc); continue; }

          const soldT = gc.soldAt ? new Date(gc.soldAt).getTime() : NaN;
          if (Number.isFinite(soldT) && soldT < cutoffSold) {
            changed = true;
            continue; // borrar giftcard vendida antigua
          }
          kept.push(gc);
        }

        if (kept.length !== arr.length) {
          inv.giftcards = kept;
          changed = true;
        }
      }
    }


  // 4) stock vendido (cuentas completas FULL) - se guardan en inventory.fullAccountsSold
  if (Array.isArray(dbData.services)) {
    for (const prod of dbData.services) {
      if (prod?.type !== "full") continue;

      const inv = prod.inventory || (prod.inventory = {});
      const sold = inv.fullAccountsSold || [];
      if (!Array.isArray(sold) || !sold.length) continue;

      const kept = [];
      for (const acc of sold) {
        const soldT = acc.soldAt ? new Date(acc.soldAt).getTime() : NaN;
        if (Number.isFinite(soldT) && soldT < cutoffSold) {
          changed = true;
          continue; // borrar full vendida antigua
        }
        kept.push(acc);
      }

      if (kept.length !== sold.length) {
        inv.fullAccountsSold = kept;
        changed = true;
      }
    }
  }

  return { changed, data: dbData };
}


/* ===== Menús + Secciones (Responsive) ===== */
function setupSidebar({ toggleSel = "#menuToggle", sidebarSel = "#sidebar", overlaySel = "#sidebarOverlay" } = {}) {
  const btn = document.querySelector(toggleSel);
  const sidebar = document.querySelector(sidebarSel);
  const overlay = document.querySelector(overlaySel);
  if (!btn || !sidebar) return { open(){}, close(){}, toggle(){} };

  const open = () => {
    sidebar.classList.add("open");
    overlay?.classList.add("show");
  };
  const close = () => {
    sidebar.classList.remove("open");
    overlay?.classList.remove("show");
  };
  const toggle = () => sidebar.classList.contains("open") ? close() : open();

  btn.addEventListener("click", toggle);
  overlay?.addEventListener("click", close);

  // Cierra al cambiar a desktop
  window.addEventListener("resize", () => {
    if (window.matchMedia("(min-width: 821px)").matches) close();
  });

  return { open, close, toggle };
}

function setupAdminNav() {
  const sidebar = setupSidebar();
  const sections = Array.from(document.querySelectorAll("[data-admin-section]"));
  const btns = Array.from(document.querySelectorAll("[data-admin-nav]"));

  const show = (key) => {
    sections.forEach(s => {
      s.style.display = (s.dataset.adminSection === key) ? "" : "none";
    });
    btns.forEach(b => b.classList.toggle("active", b.dataset.adminNav === key));
    document.dispatchEvent(new CustomEvent("admin:section", { detail: { key } }));
  };

  // Exponemos para acciones internas (p.ej. botón "Ir a stock" en resumen)
  window.__showAdminSection = (key) => {
    show(key);
    sidebar.close();
  };

  btns.forEach(b => b.addEventListener("click", () => {
    show(b.dataset.adminNav);
    sidebar.close();
  }));

  // Default: Inicio
  show("inicio");
}

function setupUserNav() {
  const sidebar = setupSidebar();
  const sections = Array.from(document.querySelectorAll("[data-user-section]"));
  const btns = Array.from(document.querySelectorAll("[data-user-nav]"));

  const show = (key) => {
    sections.forEach(s => {
      s.style.display = (s.dataset.userSection === key) ? "" : "none";
    });
    btns.forEach(b => b.classList.toggle("active", b.dataset.userNav === key));
  };

  window.__showUserSection = (key) => {
    show(key);
    sidebar.close();
  };

  btns.forEach(b => b.addEventListener("click", () => {
    show(b.dataset.userNav);
    sidebar.close();
  }));

  show("servicios");
}


/* Router */
window.addEventListener("DOMContentLoaded", async () => {
  const page = document.body.dataset.page;
  if (page === "login") return initLogin();
  if (page === "admin") return initAdmin();
  if (page === "user") return initUser();
});

/* LOGIN */
async function initLogin() {
  $("#btnAdmin")?.addEventListener("click", () => doLogin("admin"));
  $("#btnUser")?.addEventListener("click", () => doLogin("user"));

  // ===== Auto-registro (opcional, controlado por admin) =====
  const regArea = $("#registerArea");
  const btnRegister = $("#btnRegister");
  const regPanel = $("#registerPanel");
  const regMsg = $("#regMsg");

  try {
    const { data } = await loadDB();
    const enabled = !!(data.settings && data.settings.allowSelfRegister);
    if (regArea) regArea.style.display = enabled ? "block" : "none";
  } catch (e) {
    // Si no se puede cargar la DB, no mostramos el registro.
    if (regArea) regArea.style.display = "none";
  }

  btnRegister?.addEventListener("click", () => {
    if (!regPanel) return;
    const isHidden = regPanel.style.display === "none" || !regPanel.style.display;
    regPanel.style.display = isHidden ? "block" : "none";
    if (regMsg) regMsg.textContent = "";
  });

  $("#regSubmit")?.addEventListener("click", async () => {
    const username = ($("#regUsername")?.value || "").trim();
    const password = ($("#regPassword")?.value || "").trim();

    const reUser = /^[a-z0-9]+$/;
    if (!username || !password) {
      if (regMsg) regMsg.textContent = "Completa usuario y contraseña.";
      return;
    }
    if (!reUser.test(username) || !reUser.test(password)) {
      if (regMsg) regMsg.textContent = "Solo se permiten letras minúsculas y números (sin espacios ni caracteres especiales).";
      return;
    }

    try {
      const { data } = await loadDB();

      // Si el admin deshabilitó el registro, bloqueamos aquí también
      if (!(data.settings && data.settings.allowSelfRegister)) {
        if (regMsg) regMsg.textContent = "El registro está deshabilitado.";
        if (regArea) regArea.style.display = "none";
        return;
      }

      if (data.users.some(u => u.username === username)) {
        if (regMsg) regMsg.textContent = "Ese usuario ya existe.";
        return;
      }

      const exp = new Date();
      exp.setDate(exp.getDate() + 30);

      const newUser = {
        id: "u_" + uuid(),
        username,
        password,
        expiresAt: exp.toISOString().slice(0, 10), // +30 días por defecto
        balanceCOP: 0,
        createdAt: nowISO()
      };

      data.users.push(newUser);
      await saveDB(data, "Self-registered user");

      if (regMsg) regMsg.textContent = "Usuario creado. Ya puedes iniciar sesión.";
      if ($("#regUsername")) $("#regUsername").value = "";
      if ($("#regPassword")) $("#regPassword").value = "";
      if (regPanel) regPanel.style.display = "none";
    } catch (e) {
      if (regMsg) regMsg.textContent = "Error: " + (e?.message || e);
    }
  });


  async function doLogin(kind) {
    const u = $("#username").value.trim();
    const p = $("#password").value;

    try {
      const { data } = await loadDB();

      if (kind === "admin") {
        if (isExpired(data.settings.adminExpiresAt)) {
          $("#msg").textContent = "Acceso admin vencido.";
          return;
        }
        if (u === data.settings.adminUser && p === data.settings.adminPass) {
          setSession({ kind: "admin" });
          location.href = "admin.html";
        } else {
          $("#msg").textContent = "credenciales invalidas";
        }
        return;
      }

      const user = data.users.find(x => x.username === u && x.password === p);
      if (!user || isExpired(user.expiresAt)) {
        $("#msg").textContent = "credenciales invalidas";
        return;
      }
      setSession({ kind: "user", userId: user.id });
      location.href = "user.html";
    } catch (e) {
      $("#msg").textContent = "Error: " + (e?.message || e);
    }
  }
}

/* ADMIN */
async function initAdmin() {
  document.body.classList.add("admin");
  const s = getSession();
  if (!s || s.kind !== "admin") return (location.href = "index.html");

  $("#logout").addEventListener("click", () => { clearSession(); location.href = "index.html"; });

  // Menú + navegación por secciones
  setupAdminNav();

  // Buscador global (filtra según la sección activa)
  const adminSearch = { text: ""};
  let adminSectionKey = "inicio";
  const $searchText = $("#adminSearchText");
  const $searchClear = $("#adminSearchClear");

  const sectionPlaceholders = {
    inicio: "Buscar… (usuario, correo, contraseña, código)",
    usuarios: "Buscar usuarios… (usuario / contraseña)",
    productos: "Buscar productos… (nombre / key)",
    stock: "Buscar stock… (correo / contraseña / código / producto)",
    compras: "Buscar compras… (usuario / código / producto / correo)"
  };

  const applyPlaceholder = () => {
    if ($searchText) $searchText.placeholder = sectionPlaceholders[adminSectionKey] || sectionPlaceholders.inicio;
  };

  const refreshDebounced = (() => {
    let t = 0;
    return () => {
      clearTimeout(t);
      t = setTimeout(() => refresh(), 120);
    };
  })();

  const clearSearch = () => {
    adminSearch.text = "";
    if ($searchText) $searchText.value = "";
    refresh();
  };

  $searchText?.addEventListener("input", (e) => { adminSearch.text = e.target.value; refreshDebounced(); });
  $searchClear?.addEventListener("click", clearSearch);

  document.addEventListener("admin:section", (e) => {
    adminSectionKey = e.detail?.key || "inicio";
    applyPlaceholder();
    // Si hay búsqueda activa, re-renderiza al cambiar de sección
    if (adminSearch.text && adminSearch.text.trim()) refreshDebounced();
  });

  applyPlaceholder();

  // Si el input de vigencia de "Crear usuario" es type="date", ponemos mínimo hoy.
  // (Con type="date" normalmente se puede escribir también manualmente, según el navegador.)
  if ($("#newExp") && $("#newExp").type === "date") {
    $("#newExp").min = todayYMD();
  }

// ===== Cambiar contraseña admin =====
const adminPassPanel = $("#adminPassPanel");
const adminPassMsg = $("#adminPassMsg");

// ===== Habilitar/ auto-registro en login =====
const allowSelfRegisterChk = $("#allowSelfRegisterChk");
const saveAllowSelfRegister = $("#saveAllowSelfRegister");
const allowSelfRegisterMsg = $("#allowSelfRegisterMsg");

// cargar estado actual
try {
  const { data } = await loadDB();
  if (allowSelfRegisterChk) allowSelfRegisterChk.checked = !!(data.settings && data.settings.allowSelfRegister);
} catch (e) {
  if (allowSelfRegisterMsg) allowSelfRegisterMsg.textContent = "No se pudo cargar la configuración.";
}

saveAllowSelfRegister?.addEventListener("click", async () => {
  try {
    const { data } = await loadDB();
    if (!data.settings) data.settings = {};
    data.settings.allowSelfRegister = !!allowSelfRegisterChk?.checked;
    await saveDB(data, "Admin toggled self register");
    if (allowSelfRegisterMsg) allowSelfRegisterMsg.textContent = "Configuración guardada.";
  } catch (e) {
    if (allowSelfRegisterMsg) allowSelfRegisterMsg.textContent = "Error: " + (e?.message || e);
  }
});


$("#toggleAdminPass")?.addEventListener("click", () => {
  if (!adminPassPanel) return;
  const isHidden = adminPassPanel.style.display === "none" || !adminPassPanel.style.display;
  adminPassPanel.style.display = isHidden ? "block" : "none";
  if (adminPassMsg) adminPassMsg.textContent = "";
});

// 👁 ver / ocultar nueva contraseña
const btnView = $("#toggleAdminPassView");
btnView?.addEventListener("click", () => {
  const inp = $("#adminPassNew");
  if (!inp) return;

  const isPwd = (inp.type || "password") === "password";
  inp.type = isPwd ? "text" : "password";
  btnView.textContent = isPwd ? "🙈 ocultar" : "👁 ver";
});

$("#adminPassSave")?.addEventListener("click", async () => {
  try {
    const current = ($("#adminPassCurrent")?.value || "").trim();
    const next = ($("#adminPassNew")?.value || "").trim();

    if (!current || !next) {
      if (adminPassMsg) adminPassMsg.textContent = "Completa clave actual y nueva clave.";
      return;
    }

    // Solo letras y números (sin caracteres especiales, sin espacios)
    if (!/^[A-Za-z0-9]+$/.test(next)) {
      if (adminPassMsg) adminPassMsg.textContent =
        "La nueva clave solo puede tener letras y números (sin caracteres especiales).";
      return;
    }

    if (next.length < 4) {
      if (adminPassMsg) adminPassMsg.textContent = "La nueva clave debe tener mínimo 4 caracteres.";
      return;
    }

    const { data } = await loadDB();

    if (current !== data.settings.adminPass) {
      if (adminPassMsg) adminPassMsg.textContent = "Clave actual incorrecta.";
      return;
    }

    const ok = confirm("¿Confirmas cambiar la contraseña del administrador?");
    if (!ok) return;

    data.settings.adminPass = next;
    await saveDB(data, "Admin changed admin password");

    // Limpia inputs
    if ($("#adminPassCurrent")) $("#adminPassCurrent").value = "";
    if ($("#adminPassNew")) $("#adminPassNew").value = "";

    // Vuelve a ocultar (y deja el botón en 👁 ver)
    if ($("#adminPassNew")) $("#adminPassNew").type = "password";
    if (btnView) btnView.textContent = "👁 ver";

    if (adminPassMsg) adminPassMsg.textContent = "Contraseña admin actualizada ✅";

    alert("Contraseña admin cambiada ✅\n\nSe cerrará el panel para volver a iniciar sesión.");

    // Cierra panel + cierra sesión (obligas a entrar con la nueva clave)
    if (adminPassPanel) adminPassPanel.style.display = "none";
    clearSession();
    location.href = "index.html";
  } catch (e) {
    if (adminPassMsg) adminPassMsg.textContent = "Error: " + (e?.message || e);
  }
});



  let fx = 0;
  try { fx = await getUsdCopRate(); } catch { fx = 0; }

  async function refresh() {
    let { data } = await loadDB();

    // Limpieza automática (FASE 1)
    const cleaned = autoCleanupData(data, { purchasesDays: 31, soldStockDays: 2 });
    if (cleaned.changed) {
      data = cleaned.data;
      try { await saveDB(data, "Auto cleanup (31d purchases, 2d sold stock)"); } catch {}
    }

    $("#fx").textContent = fx ? `1 USD = ${toCOP(fx)} (aprox)` : "Tasa USD/COP no disponible";

    // === Buscador admin ===
    const q = (adminSearch.text || "").toString().trim().toLowerCase();
    const qHas = !!q;

    const includesQ = (v) => (v ?? "").toString().toLowerCase().includes(q);


    const matchAny = (...vals) => !qHas || vals.some(includesQ);

    /* STOCK SUMMARY (lista vertical al inicio) */
    const sumDiv = $("#stockSummary");
    if (sumDiv) {
      const rows = data.services
        .map(prod => {
          const sc = stockCount(prod, data);
          const icon = sc > 10 ? "✅" : (sc >= 2 ? "⚠️" : "🚨");
          return `
            <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid rgba(0,0,0,.08);">
              <div style="display:flex; flex-direction:column;">
                <div><b>${icon} ${prod.name}</b></div>
                <small>${prod.type} · Disponibles: <b>${sc}</b></small>
              </div>
              <button class="btnSmall" data-go-stock="${prod.key}">Ir a stock</button>
            </div>
          `;
        })
        .join("");

      sumDiv.innerHTML = rows || "<small>No hay servicios configurados.</small>";
    }

    /* USERS TABLE */
    const usersDiv = $("#users");
const filteredUsers = data.users.filter(u => {
  if (adminSectionKey !== "usuarios") return true;
  return matchAny(u.username, u.password, u.id);
});
    usersDiv.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Usuario</th>
            <th>Contraseña</th>
            <th>Vigencia</th>
            <th>Agregar saldo Usuarios</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${filteredUsers.map(u => `
            <tr>
              <td><input class="inTable" data-u="username" data-id="${u.id}" value="${u.username}"></td>
              <td><input class="inTable" data-u="password" data-id="${u.id}" value="${u.password}"></td>
              <td><input class="inTable" type="date" data-u="expiresAt" data-id="${u.id}" value="${u.expiresAt || ""}" min="${todayYMD()}"></td>
              <td>
  <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
    <!-- Saldo actual (bloqueado) -->
<input
  class="inTable"
  style="width:110px; background:#fff6d6; border:1px solid #f0d48a; color:#2b2b2b; font-weight:600;"
  value="${u.balanceCOP || 0}"
  disabled
  title="Saldo actual"
/>

    <!-- Sumar (verde suave) -->
    <input
      class="inTable"
      data-bal-add="${u.id}"
      placeholder="+ sumar"
      inputmode="numeric"
      style="width:110px; background:#eaf7ee; border:1px solid #bfe6c8;"
      title="Valor a sumar"
    />

    <!-- Restar (rojo suave) -->
    <input
      class="inTable"
      data-bal-sub="${u.id}"
      placeholder="- restar"
      inputmode="numeric"
      style="width:110px; background:#fdecec; border:1px solid #f1bcbc;"
      title="Valor a restar"
    />
  </div>
</td>

        <td>
                <div class="actions">
                  <button class="btnSmall btn-success" data-user="save" data-id="${u.id}">Guardar</button>
                  <button class="btnSmall btn-danger" data-user="delete" data-id="${u.id}">Eliminar</button>
                </div>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;

    /* STOCK TABLES */
    const productsDiv = $("#products");
    let full = data.services.filter(p => p.type === "full");
    let profile = data.services.filter(p => p.type === "profile");
    let bundle = data.services.filter(p => p.type === "bundle");
      let giftcards = data.services.filter(p => p.type === "giftcard");

    if (adminSectionKey === "productos" && qHas) {
      const f = (p) => matchAny(p.name, p.key);
      full = full.filter(f);
      profile = profile.filter(f);
      bundle = bundle.filter(f);
        giftcards = giftcards.filter(f);
    }

    const priceCell = (p) => `
      <div class="actions">
        <input class="inTable" data-price="${p.key}" value="${p.priceCOP || 0}">
        <button class="btnSmall btn-success" data-price-save="${p.key}">Guardar</button>
      </div>
    `;

    const statusCell = (p) => {
      const enabled = (p.enabled !== false);
      return `
        <div class="actions">
          <button class="btnSmall" data-svc-toggle="${p.key}">
            ${enabled ? "🟢 Habilitado" : "🔴 Deshabilitado"}
          </button>
        </div>
      `;
    };

    const fullRows = full.map(p => {
      const list = (p.inventory?.fullAccounts || []);
      return `
        <tr>
          <td><b>${p.name}</b><br/><small>${p.key}</small></td>
          <td>${statusCell(p)}</td>
          <td>${priceCell(p)}</td>
          <td>${list.length}</td>
          <td>
            <input class="inTable" data-full-email="${p.key}" placeholder="email">
            <input class="inTable" data-full-pass="${p.key}" placeholder="contraseña">
            <button class="btnSmall btn-success" data-full-add="${p.key}">Agregar</button>
          </td>
        </tr>
      `;
    }).join("");

    const profileRows = profile.map(p => {
      const total = stockCount(p, data);
      return `
        <tr>
          <td><b>${p.name}</b><br/><small>${p.key}</small></td>
          <td>${statusCell(p)}</td>
          <td>${priceCell(p)}</td>
          <td>${total}</td>
          <td>
            <input class="inTable" data-prof-email="${p.key}" placeholder="email">
            <input class="inTable" data-prof-pass="${p.key}" placeholder="contraseña">

            <select class="inTable" data-prof-count="${p.key}">
              <option value="">Perfiles (1-7)</option>
              ${[1,2,3,4,5,6,7].map(n => `<option value="${n}">${n}</option>`).join("")}
            </select>

            <div class="profFields" data-prof-fields="${p.key}"></div>

            <button class="btnSmall btn-success" data-prof-add="${p.key}">Agregar</button>

            <small>Escribe nombre y código (4–6 dígitos) por perfil.</small>
          </td>
        </tr>
      `;
    }).join("");

    const giftcardRows = giftcards.map(p => {
      const list = (p.inventory?.giftcards || []);
      return `
        <tr>
          <td><b>${p.name}</b><br/><small>${p.key}</small></td>
          <td>${statusCell(p)}</td>
          <td>${priceCell(p)}</td>
          <td>${list.length}</td>
          <td>
            <textarea class="inTable" rows="2" data-gc-codes="${p.key}" placeholder="Códigos (uno por línea)"></textarea>
            <button class="btnSmall btn-success" data-gc-add="${p.key}">Agregar</button>
            <small>Se guardan en MAYÚSCULA.</small>
          </td>
        </tr>
      `;
    }).join("");

    const bundleRows = bundle.map(p => `
      <tr>
        <td><b>${p.name}</b><br/><small>${p.key}</small></td>
        <td>${statusCell(p)}</td>
        <td>${priceCell(p)}</td>
        <td>${stockCount(p, data)}</td>
        <td><small>${(p.bundle||[]).map(x => `${x.key} x${x.qty||1}`).join(" + ")}</small></td>
      </tr>
    `).join("");

    productsDiv.innerHTML = `
      <h4>Cuentas completas</h4>
      <table>
        <thead><tr><th>Producto</th><th>Estado</th><th>Precio</th><th>Stock</th><th>Agregar cuenta</th></tr></thead>
        <tbody>${fullRows || `<tr><td colspan="5">No hay productos tipo full</td></tr>`}</tbody>
      </table>

      <hr/>

      <h4>Perfiles</h4>
      <table>
        <thead><tr><th>Producto</th><th>Estado</th><th>Precio</th><th>Stock</th><th>Agregar cuenta con perfiles</th></tr></thead>
        <tbody>${profileRows || `<tr><td colspan="5">No hay productos tipo profile</td></tr>`}</tbody>
      </table>

      <hr/>

      <h4>Gift Cards</h4>
      <table>
        <thead><tr><th>Producto</th><th>Estado</th><th>Precio</th><th>Stock</th><th>Agregar códigos</th></tr></thead>
        <tbody>${giftcardRows || `<tr><td colspan="5">No hay productos tipo giftcard</td></tr>`}</tbody>
      </table>

      <hr/>

      <h4>Combos</h4>
      <table>
        <thead><tr><th>Combo</th><th>Estado</th><th>Precio</th><th>Disponibles</th><th>Incluye</th></tr></thead>
        <tbody>${bundleRows || `<tr><td colspan="5">No hay combos</td></tr>`}</tbody>
      </table>
    `;
    /* STOCK LIST TABLES (antes de compras) */
    const stockDiv = $("#stock");
    if (stockDiv) {
      const fullProds = data.services.filter(s => s.type === "full");
      const profProds = data.services.filter(s => s.type === "profile");
      const giftProds = data.services.filter(s => s.type === "giftcard");

      const fullStockRows = fullProds.flatMap(prod => {
        const avail0 = prod.inventory?.fullAccounts || [];
        const sold0 = prod.inventory?.fullAccountsSold || [];

        const avail = (adminSectionKey === "stock" && qHas)
          ? avail0.filter(acc => matchAny(prod.name, prod.key, acc.email, acc.password))
          : avail0;

        const sold = (adminSectionKey === "stock" && qHas)
          ? sold0.filter(acc => matchAny(prod.name, prod.key, acc.email, acc.password))
          : sold0;

        const rowsAvail = avail.map(acc => `
          <tr>
            <td><b>${prod.name}</b><br/><small>${prod.key}</small></td>
            <td><input class="inTable" data-full-edit-email="${prod.key}" data-full-id="${acc.id}" value="${acc.email || ""}"></td>
            <td><input class="inTable" data-full-edit-pass="${prod.key}" data-full-id="${acc.id}" value="${acc.password || ""}"></td>
            <td><span class="badge">Disponible</span></td>
            <td><small>${acc.addedAt ? new Date(acc.addedAt).toLocaleString() : ""}</small></td>
            <td>
              <button class="btnSmall btn-success" data-full-stock-save="1" data-key="${prod.key}" data-id="${acc.id}">Guardar</button>
              <button class="btnSmall btn-danger" data-full-stock-del="1" data-key="${prod.key}" data-id="${acc.id}">Eliminar</button>
            </td>
          </tr>
        `);

        const rowsSold = sold.map(acc => `
          <tr>
            <td><b>${prod.name}</b><br/><small>${prod.key}</small></td>
            <td><input class="inTable" data-full-edit-email="${prod.key}" data-full-id="${acc.id}" value="${acc.email || ""}" readonly></td>
            <td><input class="inTable" data-full-edit-pass="${prod.key}" data-full-id="${acc.id}" value="${acc.password || ""}" readonly></td>
            <td><span class="badge">Vendido</span></td>
            <td><small>${acc.soldAt ? new Date(acc.soldAt).toLocaleString() : ""}</small></td>
            <td>
              <button class="btnSmall btn-success" data-full-stock-save="1" data-key="${prod.key}" data-id="${acc.id}">Guardar</button>
              <button class="btnSmall btn-danger" data-full-stock-del="1" data-key="${prod.key}" data-id="${acc.id}">Eliminar</button>
            </td>
          </tr>
  
        `);

        return [...rowsAvail, ...rowsSold];
      }).join("");

      const profileStockRows = profProds.flatMap(prod => {
        const accs0 = prod.inventory?.profileAccounts || [];
        const accs = (adminSectionKey === "stock" && qHas)
          ? accs0.filter(acc => {
              const prText = (acc.profiles || []).flatMap(pr => [pr.name, pr.code]).join(" ");
              return matchAny(prod.name, prod.key, acc.email, acc.password, prText);
            })
          : accs0;

        return accs.map(acc => {
          const profilesArr0 = (acc.profiles || []);

          // Si el texto coincide con la CUENTA (correo/contraseña) o el producto,
          // entonces mostramos TODOS los perfiles aunque el texto no coincida con el perfil.
          const accountMatch = matchAny(prod.name, prod.key, acc.email, acc.password);

          // Solo filtramos perfiles cuando NO fue un match por cuenta/producto,
          // o sea: cuando probablemente están buscando un perfil/código.
          const profilesArr = (adminSectionKey === "stock" && qHas && !accountMatch)
            ? profilesArr0.filter(pr => matchAny(pr.name, pr.code))
            : profilesArr0;

          const profiles = profilesArr.map((pr, idx) => `
            <div style="display:flex; gap:8px; margin-top:6px; align-items:center;">
              <input class="inTable" style="flex:1" data-prof-edit-name="${prod.key}" data-acc-id="${acc.id}" data-pidx="${idx}" value="${pr.name || ""}">
              <input class="inTable" style="width:60px" data-prof-edit-code="${prod.key}" data-acc-id="${acc.id}" data-pidx="${idx}" value="${pr.code || ""}">
              <span class="badge">${pr.available ? "Disponible" : "Vendido"}</span>
              <button class="btnSmall btn-success" data-prof-stock-save="1" data-key="${prod.key}" data-acc="${acc.id}" data-pidx="${idx}">Guardar</button>
              <button class="btnSmall btn-danger" data-prof-stock-del="1" data-key="${prod.key}" data-acc="${acc.id}" data-pidx="${idx}">Eliminar</button>
            </div>
          `).join("");

          return `
            <tr>
              <td><b>${prod.name}</b><br/><small>${prod.key}</small></td>

              <td>
                <div style="display:flex; gap:8px; flex-direction:column;">
                  <input class="inTable" data-prof-acc-email="${prod.key}" data-acc="${acc.id}" value="${acc.email || ""}">
                  <input class="inTable" data-prof-acc-pass="${prod.key}" data-acc="${acc.id}" value="${acc.password || ""}">
                  <div class="actions">
                    <button class="btnSmall btn-success" data-prof-acc-save="1" data-key="${prod.key}" data-acc="${acc.id}">Guardar cuenta</button>
                    <button class="btnSmall btn-danger" data-prof-acc-del="1" data-key="${prod.key}" data-acc="${acc.id}">Eliminar cuenta</button>
                  </div>
                </div>
              </td>

              <td>
                ${profiles || "<small>Sin perfiles</small>"}
              </td>

              <td><small>${acc.addedAt ? new Date(acc.addedAt).toLocaleString() : ""}</small></td>
            </tr>
          `;
        });
      }).join("");

      const giftStockRows = giftProds.flatMap(prod => {
        const arr0 = prod.inventory?.giftcards || [];
        const arr = (adminSectionKey === "stock" && qHas)
          ? arr0.filter(gc => matchAny(prod.name, prod.key, gc.code))
          : arr0;

        return arr.map(gc => `
          <tr>
            <td><b>${prod.name}</b><br/><small>${prod.key}</small></td>
            <td><input class="inTable" data-gc-edit-code="${prod.key}" data-gc-id="${gc.id}" value="${gc.code || ""}"></td>
            <td><span class="badge">${gc.available ? "Disponible" : "Vendido"}</span></td>
            <td><small>${gc.addedAt ? new Date(gc.addedAt).toLocaleString() : ""}</small></td>
            <td>
              <button class="btnSmall btn-success" data-gc-stock-save="1" data-key="${prod.key}" data-id="${gc.id}">Guardar</button>
              <button class="btnSmall btn-danger" data-gc-stock-del="1" data-key="${prod.key}" data-id="${gc.id}">Eliminar</button>
            </td>
          </tr>
        `);
      }).join("");

      stockDiv.innerHTML = `
        <h4>Cuentas completas en stock</h4>
        <table>
          <thead>
            <tr>
              <th>Producto</th>
              <th>Email</th>
              <th>Contraseña</th>
              <th>Estado</th>
              <th>Agregado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${fullStockRows || `<tr><td colspan="6">No hay cuentas completas en stock</td></tr>`}
          </tbody>
        </table>

        <hr/>

        <h4>Perfiles en stock</h4>
        <table>
          <thead>
            <tr>
              <th>Producto</th>
              <th>Cuenta (email/clave)</th>
              <th>Perfiles (nombre / código)</th>
              <th>Agregado</th>
            </tr>
          </thead>
          <tbody>
            ${profileStockRows || `<tr><td colspan="4">No hay cuentas por perfiles en stock</td></tr>`}
          </tbody>
        </table>

        <hr/>

        <h4>Giftcards en stock</h4>
        <table>
          <thead>
            <tr>
              <th>Producto</th>
              <th>Código</th>
              <th>Estado</th>
              <th>Agregado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${giftStockRows || `<tr><td colspan="5">No hay giftcards en stock</td></tr>`}
          </tbody>
        </table>
      `;
    }


    /* PURCHASES TABLE */
    const pDiv = $("#purchases");
    let last = [...data.purchases].slice(-200).reverse();
    if (adminSectionKey === "compras" && qHas) {
  last = last.filter(p => {
    const items = (p.items || []).flatMap(it => [
      it.name, it.email, it.password, it.profile, it.code
    ]).join(" ");
    return matchAny(p.username, p.code, p.productName, items);
  });
}

    pDiv.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Usuario</th>
            <th>Código</th>
            <th>Producto</th>
            <th>Precio</th>
            <th>Detalle entregado</th>
          </tr>
        </thead>
        <tbody>
          ${last.map(p => {
            
const detail = (p.items || []).map(it => {
  if (it.mode === "full") {
    if (it.deliveryText) return it.deliveryText.replace(/\n/g, "<br/>");
    return `${it.name}: ${it.email} / ${it.password}`;
  }
  if (it.mode === "profile") {
    const base = SHOW_PROFILE_CREDENTIALS
      ? `${it.name}: ${it.email} / ${it.password} (Perfil ${it.profile} - Código ${it.code})`
      : `${it.name}: Perfil ${it.profile} (Código ${it.code})`;
    return `${base}<br/><br/>${WARRANTY_PROFILE_TEXT.replace(/\n/g, "<br/>")}`;
  }
  if (it.mode === "giftcard") return `${it.name}: Código ${it.code}`;
  return it.name;
}).join("<br/>");
            return `
              <tr>
                <td>${new Date(p.purchasedAt).toLocaleString()}</td>
                <td>${p.username}</td>
                <td>${p.code}</td>
                <td>${p.productName}</td>
                <td>
  <small>
    ${toCOP(p.unitPriceCOP ?? 0)} x ${p.qty ?? 1}<br/>
    <b>${toCOP(p.totalPriceCOP ?? p.priceCOP ?? 0)}</b>
  </small>
</td>
                <td><small>${detail}</small></td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    `;
  }

  /* Actions */
  document.body.onclick = async (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;

    // Habilitar / Deshabilitar servicio
    if (btn.dataset.svcToggle) {
      const key = btn.dataset.svcToggle;
      const { data: d } = await loadDB();
      const p = d.services.find(x => x.key === key);
      if (!p) return;

      const currentlyEnabled = (p.enabled !== false);
      const next = !currentlyEnabled;
      const cleanName = p.name
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

      const ok = confirm(`${next ? "Habilitar" : "Deshabilitar"}: ${cleanName}`);

      if (!ok) return;

      p.enabled = next;
      await saveDB(d, `Admin toggled service ${key} => ${next}`);
      return initAdmin();
    }

    // Ir a stock desde el resumen vertical
    if (btn.dataset.goStock) {
      const key = btn.dataset.goStock;
      window.__showAdminSection?.("productos");
      const card = document.getElementById("productsCard");
      if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });

      // intenta enfocar el input de agregar stock del producto (full o profile)
      setTimeout(() => {
        const in1 = document.querySelector(`input[data-full-email="${key}"]`) ||
                    document.querySelector(`input[data-prof-email="${key}"]`) ||
                    document.querySelector(`textarea[data-gc-codes="${key}"]`);
        if (in1) in1.focus();
      }, 250);
      return;
    }

    if (btn.dataset.user === "save") {
  const id = btn.dataset.id;
  const { data: d } = await loadDB();
  const u = d.users.find(x => x.id === id);
  if (!u) return;

  const username = document.querySelector(`input[data-u="username"][data-id="${id}"]`).value.trim();
  const password = document.querySelector(`input[data-u="password"][data-id="${id}"]`).value;
  const expiresAt = document.querySelector(`input[data-u="expiresAt"][data-id="${id}"]`).value.trim();

  if (!username || !password) return alert("Usuario y contraseña son obligatorios.");

  // Saldo actual
  const current = Number(u.balanceCOP || 0);

  // Valores a sumar / restar
  const addRaw = document.querySelector(`input[data-bal-add="${id}"]`)?.value.trim() || "";
  const subRaw = document.querySelector(`input[data-bal-sub="${id}"]`)?.value.trim() || "";

  const add = addRaw === "" ? 0 : Number(addRaw);
  const sub = subRaw === "" ? 0 : Number(subRaw);

  if (!Number.isFinite(add) || add < 0) return alert("Valor a sumar inválido.");
  if (!Number.isFinite(sub) || sub < 0) return alert("Valor a restar inválido.");

  // ✅ Evita errores: no permitir sumar y restar al mismo tiempo
  if (add > 0 && sub > 0) {
    return alert("Usa SOLO sumar o SOLO restar, no ambos al mismo tiempo.");
  }

  // Si restan más de lo que hay, no permitir
  const newBalance = Math.round(current + add - sub);
  if (newBalance < 0) {
    return alert(`No se puede restar ${sub} porque el saldo actual es ${current}.`);
  }

    // ===============================
  // DETECTAR TIPO DE CAMBIO (saldo vs datos)
  // ===============================

  // Valores anteriores
  const oldUsername = u.username;
  const oldPassword = u.password;
  const oldExpires  = u.expiresAt || "";

  // Detectar cambios de datos
  const changedUsername = username !== oldUsername;
  const changedPassword = password !== oldPassword;
  const changedExpires  = (expiresAt || "") !== oldExpires;

  // Detectar operación de saldo
  const isBalanceOp = (add > 0 || sub > 0);

  // Mensaje de confirmación
  let confirmMsg = "";

  if (isBalanceOp) {
    // Mensaje específico para saldo
    confirmMsg = `¿Confirmas guardar cambios?

Saldo: ${current}  + ${add}  - ${sub}  = ${newBalance}`;
  } else {
    // Mensaje para cambios de datos (usuario/contraseña/fecha)
    if (!changedUsername && !changedPassword && !changedExpires) {
      alert("No hay cambios para guardar.");
      return;
    }
    confirmMsg = `¿Seguro que deseas cambiar este dato para el usuario "${oldUsername}"?`;
  }

  const ok = confirm(confirmMsg);
  if (!ok) return;

  // Aplicar cambios
  u.username = username;
  u.password = password;
  u.expiresAt = expiresAt || "2027-01-01";
  u.balanceCOP = newBalance;
await saveDB(d, `Admin edit user ${u.username}`);
  alert("Cambios guardados ✅");

  // Limpia campos sumar/restar para evitar doble operación accidental
  const addInp = document.querySelector(`input[data-bal-add="${id}"]`);
  const subInp = document.querySelector(`input[data-bal-sub="${id}"]`);
  if (addInp) addInp.value = "";
  if (subInp) subInp.value = "";

  return initAdmin();
}


    /* user delete */
    if (btn.dataset.user === "delete") {
      const id = btn.dataset.id;
      const ok = confirm("¿Seguro que deseas eliminar este usuario?");
      if (!ok) return;

      const { data: d } = await loadDB();
      d.users = d.users.filter(x => x.id !== id);

      await saveDB(d, `Admin deleted user ${id}`);
      return initAdmin();
    }

    /* price save */
    if (btn.dataset.priceSave) {
      const key = btn.dataset.priceSave;
      const priceRaw = document.querySelector(`input[data-price="${key}"]`).value.trim();
      const price = Number(priceRaw);
      if (!Number.isFinite(price) || price < 0) return alert("Precio inválido.");

      const { data: d } = await loadDB();
      const p = d.services.find(x => x.key === key);
      if (!p) return;
      p.priceCOP = Math.round(price);

      await saveDB(d, `Admin set price ${key}`);
      return initAdmin();
    }

    /* add full */
    if (btn.dataset.fullAdd) {
      const key = btn.dataset.fullAdd;
      const email = document.querySelector(`input[data-full-email="${key}"]`).value.trim();
      const pass = document.querySelector(`input[data-full-pass="${key}"]`).value;
      if (!email || !pass) return alert("Completa email y contraseña.");

      const { data: d } = await loadDB();
      const p = d.services.find(x => x.key === key);
      p.inventory = p.inventory || {};
      p.inventory.fullAccounts = p.inventory.fullAccounts || [];
      // ✅ Evitar EMAIL duplicado en cuentas completas (por producto)
      const normEmail = (s) => (s || "").trim().toLowerCase();
      const newEmail = normEmail(email);
      const existsEmail = (p.inventory.fullAccounts || []).some(a => normEmail(a.email) === newEmail);
      if (existsEmail) return alert(`❌ El correo ${email} ya existe en CUENTAS COMPLETAS de este producto.`);

      p.inventory.fullAccounts.push({ id: "fa_" + uuid(), email, password: pass, addedAt: nowISO() });

      await saveDB(d, `Admin add full ${key}`);
      return initAdmin();
    }

    /* add profile (select 1-7 + name/code inputs) */
    if (btn.dataset.profAdd) {
      const key = btn.dataset.profAdd;

      const email = document.querySelector(`input[data-prof-email="${key}"]`).value.trim();
      const pass = document.querySelector(`input[data-prof-pass="${key}"]`).value;

      const countSel = document.querySelector(`select[data-prof-count="${key}"]`);
      const n = Number(countSel?.value || "");

      if (!email || !pass) return alert("Completa email y contraseña.");
      if (!Number.isFinite(n) || n < 1 || n > 7) return alert("Selecciona cantidad de perfiles (1 a 7).");

      const names = [...document.querySelectorAll(`input[data-prof-name="${key}"]`)];
      const codes = [...document.querySelectorAll(`input[data-prof-code="${key}"]`)];
      if (names.length !== n || codes.length !== n) return alert("Faltan campos de perfiles. Selecciona la cantidad y completa todos.");

      const profiles = [];
      for (let i = 0; i < n; i++) {
        const name = (names[i].value || "").trim();
        const code = (codes[i].value || "").trim();

        if (!name) return alert(`Falta el nombre del perfil #${i + 1}`);
        if (!/^\d{4,6}$/.test(code)) return alert(`Código inválido en perfil #${i + 1} (debe ser 4 a 6 dígitos)`);

        profiles.push({ name, code, available: true });
      }

      const { data: d } = await loadDB();
      const p = d.services.find(x => x.key === key);
      if (!p) return alert("Producto no encontrado.");

      p.inventory = p.inventory || {};
      p.inventory.profileAccounts = p.inventory.profileAccounts || [];
      // ✅ Evitar EMAIL duplicado en cuentas de perfiles (por producto)
      const normEmail = (s) => (s || "").trim().toLowerCase();
      const newEmail = normEmail(email);
      const existsEmail = (p.inventory.profileAccounts || []).some(a => normEmail(a.email) === newEmail);
      if (existsEmail) return alert(`❌ El correo ${email} ya existe en CUENTAS DE PERFILES de este producto.`);


      // Evita duplicados de códigos en el producto  si quiero que funcione de nuebo quitarle //
     // const existingCodes = new Set();
    //  for (const acc of p.inventory.profileAccounts) {
    //    for (const pr of (acc.profiles || [])) existingCodes.add(pr.code);
     // }
   //   for (const pr of profiles) {
    //    if (existingCodes.has(pr.code)) return alert(`El código ${pr.code} ya existe en este producto. Usa otro.`);
  //    }

      p.inventory.profileAccounts.push({
        id: "pa_" + uuid(),
        email,
        password: pass,
        profiles,
        addedAt: nowISO()
      });

      await saveDB(d, `Admin add profile account ${key}`);
      alert("Cuenta por perfiles agregada ✅");
      return initAdmin();
    }

    /* add giftcards */
    if (btn.dataset.gcAdd) {
      const key = btn.dataset.gcAdd;
      const raw = document.querySelector(`textarea[data-gc-codes="${key}"]`)?.value || "";
      const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (!lines.length) return alert("Pega al menos 1 código (uno por línea).");

      // Normaliza a MAYÚSCULA
      const codes = lines.map(s => s.toUpperCase());

      // Validación simple (A-Z/0-9, entre 8 y 32 caracteres)
      for (const c of codes) {
        if (!/^[A-Z0-9]{8,32}$/.test(c)) {
          return alert(`Código inválido: ${c}\n\nUsa solo letras mayúsculas y números (8-32 caracteres).`);
        }
      }

      // ✅ Evitar duplicados dentro del mismo pegado (textarea)
      const batch = new Set();
      for (const c of codes) {
        if (batch.has(c)) return alert(`❌ Código repetido en el pegado: ${c}`);
        batch.add(c);
      }

      const { data: d } = await loadDB();
      const p = d.services.find(x => x.key === key);
      if (!p) return alert("Producto no encontrado.");

      p.inventory = p.inventory || {};
      p.inventory.giftcards = p.inventory.giftcards || [];

      // Evitar duplicados
      const existing = new Set((p.inventory.giftcards || []).map(x => x.code));
      for (const c of codes) {
        if (existing.has(c)) return alert(`El código ${c} ya existe en este producto.`);
      }

      for (const c of codes) {
        p.inventory.giftcards.push({
  id: "gc_" + uuid(),
  code: c,
  available: true,
  soldAt: null,
  addedAt: nowISO()
});
      }

      await saveDB(d, `Admin add giftcards ${key} x${codes.length}`);
      alert(`Giftcards agregadas ✅ (${codes.length})`);
      return initAdmin();
    }


    /* add giftcards */
    

    /* ===== STOCK ACTIONS ===== */

    /* FULL: guardar */
    if (btn.dataset.fullStockSave) {
      const key = btn.dataset.key;
      const id = btn.dataset.id;

      const email = document.querySelector(`input[data-full-edit-email="${key}"][data-full-id="${id}"]`)?.value.trim() || "";
      const pass  = document.querySelector(`input[data-full-edit-pass="${key}"][data-full-id="${id}"]`)?.value || "";

      if (!email || !pass) return alert("Email y contraseña son obligatorios.");

      const { data: d } = await loadDB();
      const prod = d.services.find(s => s.key === key);
      const inv = prod?.inventory || (prod.inventory = {});
      const acc = (inv.fullAccounts || []).find(a => a.id === id) || (inv.fullAccountsSold || []).find(a => a.id === id);
      if (!acc) return alert("Cuenta no encontrada.");

      acc.email = email;
      acc.password = pass;

      await saveDB(d, `Admin edit full stock ${key} ${id}`);
      alert("Actualizado ✅");
      return initAdmin();
    }

    /* GIFTCARD: guardar */
    if (btn.dataset.gcStockSave) {
      const key = btn.dataset.key;
      const id = btn.dataset.id;

      const codeRaw = document.querySelector(`input[data-gc-edit-code="${key}"][data-gc-id="${id}"]`)?.value.trim() || "";
      const code = codeRaw.toUpperCase();

      if (!/^[A-Z0-9]{8,32}$/.test(code)) return alert("Código inválido (solo A-Z/0-9, 8-32 caracteres).");

      const { data: d } = await loadDB();
      const prod = d.services.find(s => s.key === key);
      const arr = prod?.inventory?.giftcards || [];
      const gc = arr.find(x => x.id === id);
      if (!gc) return alert("Giftcard no encontrada.");

      // evitar duplicados
      const exists = arr.some(x => x.id !== id && x.code === code);
      if (exists) return alert(`El código ${code} ya existe en este producto.`);

      gc.code = code;

      await saveDB(d, `Admin edit giftcard ${key} ${id}`);
      alert("Actualizado ✅");
      return initAdmin();
    }

    /* GIFTCARD: eliminar */
    if (btn.dataset.gcStockDel) {
      const key = btn.dataset.key;
      const id = btn.dataset.id;

      const ok = confirm("¿Eliminar este código del stock?");
      if (!ok) return;

      const { data: d } = await loadDB();
      const prod = d.services.find(s => s.key === key);
      if (!prod?.inventory?.giftcards) return alert("No hay stock.");

      prod.inventory.giftcards = prod.inventory.giftcards.filter(x => x.id !== id);

      await saveDB(d, `Admin delete giftcard ${key} ${id}`);
      alert("Eliminado ✅");
      return initAdmin();
    }

    /* FULL: eliminar */
    if (btn.dataset.fullStockDel) {
      const key = btn.dataset.key;
      const id = btn.dataset.id;

      const ok = confirm("¿Eliminar esta cuenta completa del stock?");
      if (!ok) return;

      const { data: d } = await loadDB();
      const prod = d.services.find(s => s.key === key);
      const inv = prod?.inventory || (prod.inventory = {});
      const hasAny = Array.isArray(inv.fullAccounts) || Array.isArray(inv.fullAccountsSold);
      if (!hasAny) return alert("No hay stock.");

      if (Array.isArray(inv.fullAccounts)) inv.fullAccounts = inv.fullAccounts.filter(a => a.id !== id);
      if (Array.isArray(inv.fullAccountsSold)) inv.fullAccountsSold = inv.fullAccountsSold.filter(a => a.id !== id);

      await saveDB(d, `Admin delete full stock ${key} ${id}`);
      alert("Eliminado ✅");
      return initAdmin();
    }


    /* GIFTCARD: guardar */
    

    /* PROFILE ACCOUNT: guardar email/pass */
    if (btn.dataset.profAccSave) {
      const key = btn.dataset.key;
      const accId = btn.dataset.acc;

      const email = document.querySelector(`input[data-prof-acc-email="${key}"][data-acc="${accId}"]`)?.value.trim() || "";
      const pass  = document.querySelector(`input[data-prof-acc-pass="${key}"][data-acc="${accId}"]`)?.value || "";

      if (!email || !pass) return alert("Email y contraseña son obligatorios.");

      const { data: d } = await loadDB();
      const prod = d.services.find(s => s.key === key);
      const acc = prod?.inventory?.profileAccounts?.find(a => a.id === accId);
      if (!acc) return alert("Cuenta por perfiles no encontrada.");

      acc.email = email;
      acc.password = pass;

      await saveDB(d, `Admin edit profile account ${key} ${accId}`);
      alert("Cuenta actualizada ✅");
      return initAdmin();
    }

    /* PROFILE ACCOUNT: eliminar cuenta completa (todos los perfiles) */
    if (btn.dataset.profAccDel) {
      const key = btn.dataset.key;
      const accId = btn.dataset.acc;

      const ok = confirm("¿Eliminar esta cuenta por perfiles y todos sus perfiles del stock?");
      if (!ok) return;

      const { data: d } = await loadDB();
      const prod = d.services.find(s => s.key === key);
      if (!prod?.inventory?.profileAccounts) return alert("No hay stock.");

      prod.inventory.profileAccounts = prod.inventory.profileAccounts.filter(a => a.id !== accId);

      await saveDB(d, `Admin delete profile account ${key} ${accId}`);
      alert("Eliminado ✅");
      return initAdmin();
    }

    /* PROFILE: guardar nombre/código del perfil */
    if (btn.dataset.profStockSave) {
      const key = btn.dataset.key;
      const accId = btn.dataset.acc;
      const pidx = Number(btn.dataset.pidx);

      const name = document.querySelector(`input[data-prof-edit-name="${key}"][data-acc-id="${accId}"][data-pidx="${pidx}"]`)?.value.trim() || "";
      const code = document.querySelector(`input[data-prof-edit-code="${key}"][data-acc-id="${accId}"][data-pidx="${pidx}"]`)?.value.trim() || "";

      if (!name) return alert("Nombre obligatorio.");
      if (!/^\d{4,6}$/.test(code)) return alert("Código debe ser 4 a 6 dígitos.");

      const { data: d } = await loadDB();
      const prod = d.services.find(s => s.key === key);
      const acc = prod?.inventory?.profileAccounts?.find(a => a.id === accId);
      if (!acc) return alert("Cuenta no encontrada.");

      const prof = acc.profiles?.[pidx];
      if (!prof) return alert("Perfil no encontrado.");

      // (opcional) evitar duplicados de código en el producto
      const existingCodes = new Set();
      for (const a of (prod.inventory.profileAccounts || [])) {
        for (const pr of (a.profiles || [])) {
          if (a.id === accId && pr === prof) continue;
          existingCodes.add(pr.code);
        }
      }
      if (existingCodes.has(code)) return alert(`El código ${code} ya existe en este producto.`);

      prof.name = name;
      prof.code = code;

      await saveDB(d, `Admin edit profile ${key} ${accId} idx${pidx}`);
      alert("Perfil actualizado ✅");
      return initAdmin();
    }

    /* PROFILE: eliminar perfil individual */
    if (btn.dataset.profStockDel) {
      const key = btn.dataset.key;
      const accId = btn.dataset.acc;
      const pidx = Number(btn.dataset.pidx);

      const ok = confirm("¿Eliminar este perfil del stock?");
      if (!ok) return;

      const { data: d } = await loadDB();
      const prod = d.services.find(s => s.key === key);
      const acc = prod?.inventory?.profileAccounts?.find(a => a.id === accId);
      if (!acc) return alert("Cuenta no encontrada.");

      acc.profiles = (acc.profiles || []).filter((_, i) => i !== pidx);

      await saveDB(d, `Admin delete profile ${key} ${accId} idx${pidx}`);
      alert("Perfil eliminado ✅");
      return initAdmin();
    }
  };

  // Genera inputs dinamicos cuando el admin elige cantidad de perfiles
  document.body.addEventListener("change", (ev) => {
    const sel = ev.target.closest("select[data-prof-count]");
    if (!sel) return;

    const key = sel.dataset.profCount;
    const n = Number(sel.value);
    const box = document.querySelector(`div[data-prof-fields="${key}"]`);
    if (!box) return;

    if (!Number.isFinite(n) || n <= 0) {
      box.innerHTML = "";
      return;
    }

    box.innerHTML = Array.from({ length: n }, (_, i) => `
      <div style="display:flex; gap:8px; margin-top:6px;">
        <input class="inTable" data-prof-name="${key}" data-idx="${i}" placeholder="Nombre perfil ${i + 1} (ej P${i + 1})">
        <input class="inTable" data-prof-code="${key}" data-idx="${i}" placeholder="Código (4-6 dígitos)">
      </div>
    `).join("");
  });

  // ✅ Create user with optional initial balance
  $("#createUser").addEventListener("click", async () => {
    const username = $("#newUser").value.trim();
    const password = $("#newPass").value;
    const expiresAt = $("#newExp").value.trim();

    const balRaw = $("#newBalance")?.value.trim() || "";
    const balance = balRaw ? Number(balRaw) : 0;

    if (!username || !password) return alert("Usuario y contraseña requeridos.");
    if (!Number.isFinite(balance) || balance < 0) return alert("Saldo inicial inválido.");

    const { data } = await loadDB();
    if (data.users.some(u => u.username === username)) return alert("Ese usuario ya existe.");

    data.users.push({
      id: "u_" + uuid(),
      username,
      password,
      expiresAt: expiresAt || "2027-01-01",
      balanceCOP: Math.round(balance),
      createdAt: nowISO()
    });

    await saveDB(data, `Admin created user ${username}`);

    $("#newUser").value = "";
    $("#newPass").value = "";
    $("#newExp").value = "";
    if ($("#newBalance")) $("#newBalance").value = "";

    alert("Usuario creado correctamente ✅");
    location.reload();
  });

  refresh();}

/* USER (sin tabla, mantiene cards) */

/* USER (sin tabla, mantiene cards) */
async function initUser() {
  const s = getSession();
  if (!s || s.kind !== "user") return (location.href = "index.html");

  $("#logout")?.addEventListener("click", () => { clearSession(); location.href = "index.html"; });

  // Menú + navegación por secciones
  setupUserNav();

    // ===== Cambiar contraseña del usuario (panel usuario) =====
  const userPassPanel = $("#userPassPanel");
  const userPassMsg = $("#userPassMsg");

  $("#toggleUserPass")?.addEventListener("click", () => {
    if (!userPassPanel) return;
    const isHidden = userPassPanel.style.display === "none" || !userPassPanel.style.display;
    userPassPanel.style.display = isHidden ? "block" : "none";
    if (userPassMsg) userPassMsg.textContent = "";
  });

  // 👁 ver / ocultar nueva contraseña
  const btnEye = $("#toggleUserPassEye");
  btnEye?.addEventListener("click", () => {
    const inp = $("#userPassNew");
    if (!inp) return;

    const isPwd = (inp.type || "password") === "password";
    inp.type = isPwd ? "text" : "password";
    btnEye.textContent = isPwd ? "🙈 ocultar" : "👁 ver";
  });

  $("#userPassSave")?.addEventListener("click", async () => {
    try {
      const current = ($("#userPassCurrent")?.value || "").trim();
      const next = ($("#userPassNew")?.value || "").trim();

      if (!current || !next) {
        if (userPassMsg) userPassMsg.textContent = "Completa clave actual y nueva clave.";
        return;
      }

      // Solo letras y números (sin espacios ni caracteres especiales)
      if (!/^[A-Za-z0-9]+$/.test(next)) {
        if (userPassMsg) userPassMsg.textContent =
          "La nueva clave solo puede tener letras y números (sin caracteres especiales).";
        return;
      }

      if (next.length < 4) {
        if (userPassMsg) userPassMsg.textContent = "La nueva clave debe tener mínimo 4 caracteres.";
        return;
      }

      // Verifica usuario actual con DB
      const { data } = await loadDB();
      const me = data.users.find(u => u.id === s.userId);

      if (!me || isExpired(me.expiresAt)) {
        clearSession();
        location.href = "index.html";
        return;
      }

      if ((me.password || "") !== current) {
        if (userPassMsg) userPassMsg.textContent = "Clave actual incorrecta.";
        return;
      }

      const ok = confirm("¿Confirmas cambiar tu contraseña?");
      if (!ok) return;

      me.password = next;
      await saveDB(data, `User changed password ${me.username}`);

      // Limpia inputs y oculta panel
      if ($("#userPassCurrent")) $("#userPassCurrent").value = "";
      if ($("#userPassNew")) $("#userPassNew").value = "";
      if ($("#userPassNew")) $("#userPassNew").type = "password";
      if (btnEye) btnEye.textContent = "👁 ver";
      if (userPassPanel) userPassPanel.style.display = "none";

      if (userPassMsg) userPassMsg.textContent = "Contraseña actualizada ✅";

      alert("Contraseña cambiada ✅\n\nSe cerrará tu sesión para volver a iniciar con tu nueva clave.");

      // Cierra sesión automáticamente (seguridad)
      clearSession();
      location.href = "index.html";
    } catch (e) {
      if (userPassMsg) userPassMsg.textContent = "Error: " + (e?.message || e);
    }
  });


  const qtyState = Object.create(null);

  let fx = 0;
  try { fx = await getUsdCopRate(); } catch { fx = 0; }

  async function refresh() {
    const { data } = await loadDB();
    const me = data.users.find(u => u.id === s.userId);
    if (!me || isExpired(me.expiresAt)) {
      clearSession();
      return (location.href = "index.html");
    }

    const usd = fx ? (me.balanceCOP / fx) : 0;
    $("#who").textContent = me.username;

    const msg = encodeURIComponent(`Deseo recargar saldo a mi usuario de la web: ${me.username}`);
    const a = document.querySelector("#topupBtn");
    if (a) a.href = `https://wa.me/573206199480?text=${msg}`;

    $("#bal").textContent = `${toCOP(me.balanceCOP)} / ${toUSD(usd)}`;
    $("#fx").textContent = fx ? `1 USD = ${toCOP(fx)} (aprox)` : "Tasa USD/COP no disponible";

    const grid = $("#grid");
    grid.innerHTML = "";

    data.services.filter(p => p.enabled !== false).forEach(prod => {
      const sc = stockCount(prod, data);
      const unitPrice = Number(prod.priceCOP || 0);

      // Mantener qty en rango
      const maxQty = Math.max(1, sc);
      let q = Number(qtyState[prod.key] || 1);
      if (!Number.isFinite(q)) q = 1;
      q = Math.min(Math.max(q, 1), maxQty);
      qtyState[prod.key] = q;

      const canBuy = sc > 0 && unitPrice > 0;

      const el = document.createElement("div");
      el.className = "card serviceCard";
      el.innerHTML = `
        <img src="${prod.image}" alt="${prod.name}"/>
        <h3 style="margin:10px 0 6px 0;">${prod.name}</h3>
        <div><small>Tipo: ${prod.type} | Precio: ${toCOP(unitPrice)} | Stock: ${sc}</small></div>

        <div style="display:flex; align-items:center; gap:10px; margin:10px 0;">
          <button data-qty-minus="${prod.key}" ${sc > 0 && q > 1 ? "" : "disabled"}>-</button>
          <b data-qty-val="${prod.key}">${q}</b>
          <button data-qty-plus="${prod.key}" ${sc > 0 && q < sc ? "" : "disabled"}>+</button>
          <small style="opacity:.8">cantidad</small>
        </div>

        <button data-buy="${prod.key}" ${canBuy ? "" : "disabled"}>
          ${sc <= 0 ? "Sin stock" : (unitPrice <= 0 ? "Precio no disponible" : `Comprar x${q}`)}
        </button>
      `;
      grid.appendChild(el);
    });

    const myPurch = data.purchases.filter(p => p.userId === me.id).slice(-20).reverse();
    const div = $("#myPurchases");
    div.innerHTML = "";

    myPurch.forEach(p => {
      
const itemsText = (p.items || []).map(it => {
  if (it.mode === "full") {
    if (it.deliveryText) return it.deliveryText.replace(/\n/g, "<br/>");
    return `${it.name}: ${it.email} / ${it.password}`;
  }
  if (it.mode === "profile") {
    const base = SHOW_PROFILE_CREDENTIALS
      ? `${it.name}: ${it.email} / ${it.password} (Perfil ${it.profile} - Código ${it.code})`
      : `${it.name}: Perfil ${it.profile} (Código ${it.code})`;
    return `${base}<br/><br/>${WARRANTY_PROFILE_TEXT.replace(/\n/g, "<br/>")}`;
  }
  if (it.mode === "giftcard") return `${it.name}: Código ${it.code}`;
  return it.name;
}).join("<br/>");

      const qty = Number(p.qty || 1);
      const total = Number(p.totalPriceCOP || p.priceCOP || 0);

      const el = document.createElement("div");
      el.className = "card";
      el.innerHTML = `
        <div><b>${p.productName}</b> <span class="badge">${p.code}</span></div>
        <small>Fecha: ${new Date(p.purchasedAt).toLocaleString()}</small><br/>
        <small>Cantidad: ${qty} | Total: ${toCOP(total)}</small>
        <hr/>
        <div><small>${itemsText}</small></div>
      `;
      div.appendChild(el);
    });
  }

  document.body.onclick = async (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;

    // Ajuste de cantidad
    if (btn.dataset.qtyMinus || btn.dataset.qtyPlus) {
      const key = btn.dataset.qtyMinus || btn.dataset.qtyPlus;

      const { data } = await loadDB();
      const prod = data.services.find(x => x.key === key);
      if (!prod) return;

      const sc = stockCount(prod, data);
      let q = Number(qtyState[key] || 1);

      if (btn.dataset.qtyMinus) q = Math.max(1, q - 1);
      if (btn.dataset.qtyPlus) q = Math.min(Math.max(1, sc), q + 1);

      qtyState[key] = q;

      const val = document.querySelector(`[data-qty-val="${key}"]`);
      if (val) val.textContent = String(q);

      const minus = document.querySelector(`button[data-qty-minus="${key}"]`);
      const plus = document.querySelector(`button[data-qty-plus="${key}"]`);
      if (minus) minus.disabled = !(sc > 0 && q > 1);
      if (plus) plus.disabled = !(sc > 0 && q < sc);

      const buyBtn = document.querySelector(`button[data-buy="${key}"]`);
      const unitPrice = Number(prod.priceCOP || 0);
      if (buyBtn) {
        const canBuy = sc > 0 && unitPrice > 0;
        buyBtn.disabled = !canBuy;
        buyBtn.textContent = sc <= 0 ? "Sin stock" : (unitPrice <= 0 ? "Precio no disponible" : `Comprar x${q}`);
      }
      return;
    }

    // Comprar
    if (btn.dataset.buy) {
      const productKey = btn.dataset.buy;
      const qty = Math.max(1, Number(qtyState[productKey] || 1));

      const { data: d } = await loadDB();
      const user = d.users.find(u => u.id === s.userId);
      const prod = d.services.find(x => x.key === productKey);
      if (!user || !prod) return alert("Error interno.");

      const sc = stockCount(prod, d);
      if (sc <= 0) return alert("No hay stock disponible.");
      if (qty > sc) return alert(`Solo hay ${sc} disponibles. Baja la cantidad.`);

      const unitPrice = Number(prod.priceCOP || 0);
      if (unitPrice <= 0) {
        const msg2 = encodeURIComponent(
          `Ahora mismo no puedes comprar porque el administrador no ha puesto el precio para este servicio.\n\nServicio: ${prod.name}\nUsuario: ${user.username}`
        );
        alert("Ahora mismo no puedes comprar porque el administrador no ha puesto el precio para este servicio. Contacta soporte y cuéntale esta novedad.");
        window.open(`https://wa.me/573206199480?text=${msg2}`, "_blank", "noopener");
        return;
      }

      const totalPrice = unitPrice * qty;
      if ((user.balanceCOP || 0) < totalPrice) return alert("Saldo insuficiente.");

      const cleanName = prod.name
     .replace(/<br\s*\/?>/gi, ' ')
     .replace(/\s+/g, ' ')
     .trim();

      const ok = confirm(
      `¿Confirmas comprar ${qty} unidad(es) de ${cleanName} por ${toCOP(totalPrice)}?`
      );
      if (!ok) return;


      
      // Validación previa bundles
      if (prod.type === "bundle") {
        for (const it of (prod.bundle || [])) {
          const child = d.services.find(sv => sv.key === it.key);
          if (!child) return alert("Combo mal configurado.");
          const need = (it.qty || 1) * qty;
          if (stockCount(child, d) < need) return alert(`Stock insuficiente para: ${child.name} (necesitas ${need})`);
        }
      }

      const itemsDelivered = [];

      for (let k = 0; k < qty; k++) {
        
if (prod.type === "full") {
          const acct = takeFullAccount(prod);
          if (!acct) return alert("No hay stock disponible.");

          // ✅ SOLO Netflix FULL: agrega mensaje estándar con email/contraseña vendidos
          const isNetflix =
            (prod.key || "").toLowerCase().includes("netflix") ||
            (prod.name || "").toLowerCase().includes("netflix");

          if (isNetflix) {
            itemsDelivered.push({
              name: prod.name,
              mode: "full",
              email: acct.email,
              password: acct.password,
              deliveryText: buildNetflixFullMessage(acct.email, acct.password)
            });
          } else {
            itemsDelivered.push({ name: prod.name, mode: "full", email: acct.email, password: acct.password });
          }
        } else if (prod.type === "profile") {
          const got = takeProfile(prod);
          if (!got) return alert("No hay perfiles disponibles.");
          itemsDelivered.push({ name: prod.name, mode: "profile", email: got.email, password: got.password, profile: got.profile, code: got.code });
        } else if (prod.type === "giftcard") {
          const gc = takeGiftcard(prod);
          if (!gc) return alert("No hay giftcards disponibles.");
          itemsDelivered.push({ name: prod.name, mode: "giftcard", code: gc.code });
        } else if (prod.type === "bundle") {
          for (const it of (prod.bundle || [])) {
            const child = d.services.find(sv => sv.key === it.key);
            const need = it.qty || 1;
            for (let i = 0; i < need; i++) {
              if (child.type === "full") {
                const acct = takeFullAccount(child);
                itemsDelivered.push({ name: child.name, mode: "full", email: acct.email, password: acct.password });
              } else if (child.type === "profile") {
                const got = takeProfile(child);
                itemsDelivered.push({ name: child.name, mode: "profile", email: got.email, password: got.password, profile: got.profile, code: got.code });
              } else {
                return alert("No se permite bundle dentro de bundle.");
              }
            }
          }
        } else {
          return alert("Tipo de producto no soportado.");
        }
      }

      user.balanceCOP = Number(user.balanceCOP || 0) - totalPrice;

      const purchase = {
        id: "p_" + uuid(),
        code: "C-" + uuid(),
        userId: user.id,
        username: user.username,
        productKey: prod.key,
        productName: prod.name,
        unitPriceCOP: unitPrice,
        qty,
        totalPriceCOP: totalPrice,
        items: itemsDelivered,
        purchasedAt: nowISO()
      };

      d.purchases.push(purchase);
      await saveDB(d, `Purchase ${purchase.code} by ${user.username}`);

      
const lines = itemsDelivered.map(it => {
  if (it.mode === "full") {
    if (it.deliveryText) return it.deliveryText;
    return `${it.name}
Correo: ${it.email}
Contraseña: ${it.password}`;
  }
  if (it.mode === "profile") {
    const base = SHOW_PROFILE_CREDENTIALS
      ? `${it.name}
Correo: ${it.email}
Contraseña: ${it.password}
Perfil: ${it.profile}
Código: ${it.code}`
      : `${it.name}
Perfil: ${it.profile}
Código: ${it.code}`;
    return `${base}

${WARRANTY_PROFILE_TEXT}`;
  }
  if (it.mode === "giftcard") return `${it.name}: Código ${it.code}`;
  return it.name;
}).join("\n\n");

      alert(`Compra exitosa ✅\n\nCantidad: ${qty}\nTotal: ${toCOP(totalPrice)}\n\n${lines}\n\nFecha: ${new Date(purchase.purchasedAt).toLocaleString()}\nCódigo: ${purchase.code}`);
      await refresh();
      return;
    }
  };

  await refresh();
}
