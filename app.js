/**
 * app.js - Lógica de Interfaz, Navegación y Procesos
 * Optimizado para carga bajo demanda, sistema de firmas y Magic Links.
 */

// 1. ESTADO GLOBAL DE LA APLICACIÓN
const AppState = {
    tickets: [],
    materiales: [],
    tecnicos: [],
    currentTicket: null // Para rastrear el ticket en edición/resolución
};

// 2. MÓDULO DE AUTENTICACIÓN
const AuthModule = {
    currentUser: null,
    
    login: async function() {
        const u = document.getElementById('login-user').value.trim();
        const p = document.getElementById('login-pass').value.trim();
        const btn = document.querySelector('#login-screen .btn');
        const errorMsg = document.getElementById('login-error');

        try {
            btn.innerText = "Validando..."; btn.disabled = true;
            errorMsg.style.display = 'none';
            
            // Validación en el servidor (n8n/PostgreSQL)
            const user = await API.auth.login(u, p);
            
            if (user && user.nombre) {
                this.currentUser = user;
                this.iniciarInterfaz();
            }
        } catch (e) {
            errorMsg.style.display = 'block';
            API.log('Error de login', { usuario: u, error: e.message }, 'ERROR');
        } finally {
            btn.innerText = "Ingresar"; btn.disabled = false;
        }
    },

    iniciarInterfaz: function() {
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('app-container').classList.remove('hidden');
        document.getElementById('current-user-name').innerText = this.currentUser.nombre;

        const esAnalista = this.currentUser.tipo === 'analista';
        document.getElementById('menu-analista').classList.toggle('hidden', !esAnalista);
        document.getElementById('menu-operaciones').classList.toggle('hidden', esAnalista);

        UIModule.navigate(esAnalista ? 'dashboard-analista' : 'dashboard-operaciones');
    },

    logout: function() {
        this.currentUser = null;
        API.log('Cierre de sesión', {});
        location.reload(); 
    }
};

// 3. MÓDULO DE TICKETS (LÓGICA DE NEGOCIO)
const TicketModule = {
    pad: null,
    drawing: false,

    prepararFormulario: function() {
        document.getElementById('nt-datos-cliente').classList.add('hidden');
        document.getElementById('nt-cedula-num').value = '';
        this.generarHoras();
    },

    buscarCliente: async function() {
        const tipo = document.getElementById('nt-cedula-tipo').value;
        const num = document.getElementById('nt-cedula-num').value.trim();
        const btn = document.querySelector('#view-nuevo-ticket .btn-primary');

        if (!num) return alert("Ingrese una cédula");

        try {
            btn.innerText = "..."; btn.disabled = true;
            const c = await API.clientes.buscar(`${tipo}-${num}`);
            
            if(c) {
                document.getElementById('nt-nombre').value = c.Cliente_nombre;
                document.getElementById('nt-telefono').value = c.telefono;
                document.getElementById('nt-zona').value = c.zona;
                document.getElementById('nt-caja-nap').value = c.caja_nap || '';
                document.getElementById('nt-datos-cliente').classList.remove('hidden');
            }
        } catch (e) { alert("Cliente no encontrado en TETENET"); }
        finally { btn.innerText = "Buscar"; btn.disabled = false; }
    },

    generarHoras: function() {
        const sel = document.getElementById('nt-hora');
        sel.innerHTML = '';
        let h = 7, m = 30;
        while(h < 17) {
            let lbl = `${h.toString().padStart(2, '0')}:${m === 0 ? '00' : '30'}`;
            sel.innerHTML += `<option>${lbl}</option>`;
            m += 30; if(m === 60) { m = 0; h++; }
        }
    },

    crearTicket: async function() {
        const datos = {
            cedula: document.getElementById('nt-cedula-tipo').value + "-" + document.getElementById('nt-cedula-num').value,
            Cliente_nombre: document.getElementById('nt-nombre').value,
            zona: document.getElementById('nt-zona').value,
            caja_nap: document.getElementById('nt-caja-nap').value,
            categoria: document.getElementById('nt-motivo').value,
            asignado_a: document.getElementById('nt-tecnico').value,
            hora: document.getElementById('nt-hora').value,
            estado: 'pendiente',
            fecha: new Date().toISOString().split('T')[0]
        };

        try {
            await API.tickets.crear(datos);
            alert("Ticket creado y notificado a n8n");
            UIModule.navigate('dashboard-analista');
        } catch (e) { alert("Error al guardar"); }
    },

    // RESOLUCIÓN DE TICKET (OPERACIONES)
    abrirResolucion: async function(id) {
        UIModule.navigate('resolver-ticket');
        const t = AppState.tickets.find(x => x.id === id);
        if (!t) return;
        
        AppState.currentTicket = t;
        document.getElementById('rt-id').innerText = t.id;
        document.getElementById('rt-cliente').innerText = t.Cliente_nombre;
        document.getElementById('rt-dir').innerText = t.direccion || 'Consultar en sitio';
        document.getElementById('rt-caja-nap').innerText = t.caja_nap || 'N/A';

        const formDiv = document.getElementById('rt-formulario-resolucion');
        const pendDiv = document.getElementById('rt-estado-pendiente');

        if (t.estado === 'pendiente') {
            formDiv.classList.add('hidden');
            pendDiv.classList.remove('hidden');
        } else {
            formDiv.classList.remove('hidden');
            pendDiv.classList.add('hidden');
            this.iniciarCanvas();
            if (AppState.materiales.length === 0) {
                AppState.materiales = await API.catalogos.getMateriales();
            }
        }
    },

    iniciarSoporte: async function() {
        try {
            await API.tickets.iniciar({ id: AppState.currentTicket.id });
            AppState.currentTicket.estado = 'en curso';
            this.abrirResolucion(AppState.currentTicket.id);
        } catch (e) { alert("No se pudo iniciar"); }
    },

    cerrarTicket: async function(estado) {
        const canvas = document.getElementById('signature-pad');
        const datos = {
            id: AppState.currentTicket.id,
            estado: estado,
            solucion: document.getElementById('rt-descripcion').value,
            monto: parseFloat(document.getElementById('rt-total-monto').innerText),
            firma: estado === 'resuelto' ? canvas.toDataURL() : null,
            fecha_solucion: new Date().toISOString().split('T')[0]
        };

        try {
            await API.tickets.cerrar(datos);
            UIModule.navigate('dashboard-operaciones');
        } catch (e) { alert("Error al cerrar ticket"); }
    },

    // LÓGICA DE FIRMA Y MATERIALES
    iniciarCanvas: function() {
        const canvas = document.getElementById('signature-pad');
        canvas.width = canvas.parentElement.offsetWidth; canvas.height = 200;
        const ctx = canvas.getContext('2d');
        ctx.strokeStyle = "#222"; ctx.lineWidth = 2;
        
        const getPos = (e) => {
            const r = canvas.getBoundingClientRect();
            return { x: (e.touches ? e.touches[0].clientX : e.clientX) - r.left, y: (e.touches ? e.touches[0].clientY : e.clientY) - r.top };
        };
        canvas.onmousedown = canvas.ontouchstart = (e) => { e.preventDefault(); this.drawing = true; const p = getPos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
        canvas.onmousemove = canvas.ontouchmove = (e) => { if(this.drawing) { const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); } };
        canvas.onmouseup = canvas.ontouchend = () => this.drawing = false;
    },

    toggleMateriales: function() {
        const si = document.getElementById('rt-uso-materiales').value === 'si';
        document.getElementById('rt-seccion-materiales').classList.toggle('hidden', !si);
        if(si && document.getElementById('rt-lista-materiales').innerHTML === '') this.agregarMaterial();
        this.calcularTotal();
    },

    agregarMaterial: function() {
        const options = AppState.materiales.map(m => `<option value="${m.precio}">${m.nombre} ($${m.precio})</option>`).join('');
        const div = document.createElement('div');
        div.className = 'form-row';
        div.innerHTML = `<select class="mat-select" onchange="TicketModule.calcularTotal()" style="flex:2">${options}</select>
                         <input type="number" class="mat-qty" value="1" onchange="TicketModule.calcularTotal()" style="width:70px">
                         <button class="btn btn-danger" onclick="this.parentElement.remove(); TicketModule.calcularTotal()">X</button>`;
        document.getElementById('rt-lista-materiales').appendChild(div);
        this.calcularTotal();
    },

    calcularTotal: function() {
        let t = document.getElementById('rt-tipo-visita').value === 'paga' ? 10 : 0;
        document.querySelectorAll('#rt-lista-materiales .form-row').forEach(row => {
            t += parseFloat(row.querySelector('.mat-select').value) * parseInt(row.querySelector('.mat-qty').value);
        });
        document.getElementById('rt-total-monto').innerText = t.toFixed(2);
    }
};

// 4. MÓDULO DE INTERFAZ
const UIModule = {
    navigate: async function(viewId) {
        document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
        document.getElementById(`view-${viewId}`).classList.remove('hidden');
        document.getElementById('sidebar').classList.remove('active');

        try {
            if (viewId === 'dashboard-analista') {
                AppState.tickets = await API.tickets.getAnalista();
                ChartModule.render();
                this.renderTablaAnalista();
            } else if (viewId === 'dashboard-operaciones') {
                AppState.tickets = await API.tickets.getOperaciones(AuthModule.currentUser.nombre);
                this.renderTablaOperaciones();
            } else if (viewId === 'planificacion') {
                AppState.tickets = await API.tickets.getAnalista();
                AppState.tecnicos = await API.catalogos.getTecnicos();
                PlanificacionModule.render();
            } else if (viewId === 'nuevo-ticket') {
                AppState.tecnicos = await API.catalogos.getTecnicos();
                this.llenarSelectTecnicos();
                TicketModule.prepararFormulario();
            }
        } catch (e) { API.log('Error de navegación', { viewId, error: e.message }, 'ERROR'); }
    },

    toggleSidebar: () => document.getElementById('sidebar').classList.toggle('active'),

    renderTablaAnalista: function() {
        const tbody = document.querySelector('#table-all-tickets tbody');
        tbody.innerHTML = AppState.tickets.map(t => `
            <tr>
                <td>${t.id}</td><td>${t.Cliente_nombre}</td><td>${t.asignado_a}</td>
                <td><span class="badge bg-${t.estado.replace(' ', '')}">${t.estado}</span></td>
                <td>${t.fecha}</td><td>${t.fecha_solucion || '---'}</td>
                <td><button class="btn btn-info" onclick="UIModule.verPreview('${t.id}')">👁️</button></td>
            </tr>
        `).join('');
    },

    renderTablaOperaciones: function() {
        const tbody = document.querySelector('#table-op-tickets tbody');
        tbody.innerHTML = AppState.tickets.map(t => `
            <tr>
                <td>${t.id}</td><td>${t.Cliente_nombre}</td><td>${t.hora}</td>
                <td><span class="badge bg-${t.estado.replace(' ', '')}">${t.estado}</span></td>
                <td><button class="btn btn-primary" onclick="TicketModule.abrirResolucion('${t.id}')">Gestionar</button></td>
            </tr>
        `).join('');
    },

    llenarSelectTecnicos: function() {
        const sel = document.getElementById('nt-tecnico');
        sel.innerHTML = AppState.tecnicos.map(t => `<option value="${t.nombre}">${t.nombre}</option>`).join('');
    },

    verPreview: (id) => alert("Cargando vista previa para ticket " + id), // Aquí puedes integrar html2pdf
    cerrarPreview: () => document.getElementById('modal-preview').classList.add('hidden')
};

// 5. MÓDULOS DE VISUALIZACIÓN (GRÁFICOS Y KANBAN)
const ChartModule = {
    render: function() {
        const ctx = document.getElementById('chartDiario');
        if (!ctx) return;
        // Lógica simplificada de conteo para Chart.js
        const stats = { resueltos: 0, pendientes: 0, curso: 0 };
        AppState.tickets.forEach(t => { if(stats[t.estado] !== undefined) stats[t.estado]++; });
        // Aquí instanciarías new Chart(...) con stats
    }
};

const PlanificacionModule = {
    render: function() {
        const board = document.getElementById('kanban-board');
        board.innerHTML = AppState.tecnicos.map(tec => {
            const tks = AppState.tickets.filter(t => t.asignado_a === tec.nombre);
            return `
                <div class="kanban-column">
                    <div class="kanban-header">${tec.nombre} (${tks.length})</div>
                    <div class="kanban-body">
                        ${tks.map(t => `<div class="kanban-card"><b>${t.hora}</b>: ${t.Cliente_nombre}</div>`).join('')}
                    </div>
                </div>`;
        }).join('');
    }
};

// 6. INICIALIZACIÓN Y MAGIC LINKS
window.onload = async () => {
    API.log('App Cargada', { url: window.location.href });

    const urlParams = new URLSearchParams(window.location.search);
    const magicTicket = urlParams.get('ticket');
    const magicTech = urlParams.get('tech');

    if (magicTicket && magicTech) {
        // En un sistema real, aquí podrías usar un token o validar contra el nombre del técnico
        API.log('Magic Link Detectado', { magicTicket, magicTech });
        // Simulación de login o búsqueda de sesión
        alert("Acceso rápido detectado para " + magicTech);
    }
};