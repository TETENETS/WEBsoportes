/**
 * app.js - Lógica de Interfaz y Procesos
 */
const AppState = { tickets: [], materiales: [], tecnicos: [], currentTicket: null };

const AuthModule = {
    currentUser: null,
    login: async function() {
        const u = document.getElementById('login-user').value.trim();
        const p = document.getElementById('login-pass').value.trim();
        try {
            const user = await API.auth.login(u, p);
            if (user && user.nombre) {
                this.currentUser = user;
                this.iniciarInterfaz();
            }
        } catch (e) { document.getElementById('login-error').style.display = 'block'; }
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
    logout: () => location.reload()
};

const TicketModule = {
    pad: null, drawing: false,

    prepararFormulario: async function() {
        document.getElementById('nt-datos-cliente').classList.add('hidden');
        document.getElementById('nt-fecha').value = new Date().toISOString().split('T')[0];
        try {
            // Extrae técnicos (usuarios tipo operaciones)
            const lista = await API.catalogos.getTecnicos();
            const sel = document.getElementById('nt-tecnico');
            sel.innerHTML = lista.map(t => `<option value="${t.nombre_tecnico}">${t.nombre_tecnico}</option>`).join('');
            this.generarHoras();
        } catch (e) { API.log('Carga técnicos fallida', e.message, 'ERROR'); }
    },

    buscarCliente: async function() {
        const tipo = document.getElementById('nt-cedula-tipo').value;
        const num = document.getElementById('nt-cedula-num').value.trim();
        try {
            const c = await API.clientes.buscar(`${tipo}-${num}`);
            if(c) {
                document.getElementById('nt-nombre').value = c.Cliente_nombre;
                document.getElementById('nt-zona').value = c.zona;
                document.getElementById('nt-caja-nap').value = c.caja_nap || '';
                document.getElementById('nt-datos-cliente').classList.remove('hidden');
            }
        } catch (e) { alert("Cliente no encontrado"); }
    },

    generarHoras: async function() {
        const tec = document.getElementById('nt-tecnico').value;
        const fecha = document.getElementById('nt-fecha').value;
        const selHora = document.getElementById('nt-hora');
        if (!tec || !fecha) return;

        try {
            // Consulta tickets ocupados para ESE técnico en ESA fecha
            const ocupadasData = await API.tickets.getDisponibilidad(tec, fecha);
            const horasOcupadas = ocupadasData.map(t => t.hora);

            selHora.innerHTML = '';
            let h = 7, m = 30;
            while(h < 17) {
                let lbl = `${h.toString().padStart(2, '0')}:${m === 0 ? '00' : '30'}`;
                // Si la hora NO está ocupada para ese día/técnico, se muestra
                if (!horasOcupadas.includes(lbl)) {
                    selHora.innerHTML += `<option>${lbl}</option>`;
                }
                m += 30; if(m === 60) { m = 0; h++; }
            }
        } catch (e) { console.error("Error disponibilidad:", e); }
    },

    toggleMotivo: function() {
        const select = document.getElementById('nt-motivo');
        const inputOtro = document.getElementById('nt-motivo-otro');
        inputOtro.classList.toggle('hidden', select.value !== 'Otro');
    },

    crearTicket: async function() {
        let cat = document.getElementById('nt-motivo').value;
        if(cat === 'Otro') cat = document.getElementById('nt-motivo-otro').value;
        
        const datos = {
            id: "TCK-" + Date.now().toString().slice(-4),
            cedula: document.getElementById('nt-cedula-tipo').value + "-" + document.getElementById('nt-cedula-num').value,
            Cliente_nombre: document.getElementById('nt-nombre').value,
            zona: document.getElementById('nt-zona').value,
            caja_nap: document.getElementById('nt-caja-nap').value,
            categoria: cat,
            asignado_a: document.getElementById('nt-tecnico').value,
            hora: document.getElementById('nt-hora').value,
            fecha: document.getElementById('nt-fecha').value,
            estado: 'pendiente'
        };

        try {
            await API.tickets.crear(datos);
            alert("Ticket Guardado");
            UIModule.navigate('dashboard-analista');
        } catch (e) { alert("Error al guardar"); }
    },

    // RESOLUCIÓN
    abrirResolucion: async function(id) {
        UIModule.navigate('resolver-ticket');
        const t = AppState.tickets.find(x => x.id === id);
        AppState.currentTicket = t;
        document.getElementById('rt-id').innerText = t.id;
        document.getElementById('rt-cliente').innerText = t.Cliente_nombre;
        
        const isPend = t.estado === 'pendiente';
        document.getElementById('rt-estado-pendiente').classList.toggle('hidden', !isPend);
        document.getElementById('rt-formulario-resolucion').classList.toggle('hidden', isPend);
        
        if(!isPend) {
            this.iniciarCanvas();
            if(AppState.materiales.length === 0) AppState.materiales = await API.catalogos.getMateriales();
        }
    },

    iniciarSoporte: async function() {
        await API.tickets.iniciar({ id: AppState.currentTicket.id });
        AppState.currentTicket.estado = 'en curso';
        this.abrirResolucion(AppState.currentTicket.id);
    },

    cerrarTicket: async function(est) {
        const datos = {
            id: AppState.currentTicket.id,
            estado: est,
            solucion: document.getElementById('rt-descripcion').value,
            monto: parseFloat(document.getElementById('rt-total-monto').innerText),
            firma: est === 'resuelto' ? document.getElementById('signature-pad').toDataURL() : null,
            fecha_solucion: new Date().toISOString().split('T')[0]
        };
        await API.tickets.cerrar(datos);
        UIModule.navigate('dashboard-operaciones');
    },

    iniciarCanvas: function() {
        const canvas = document.getElementById('signature-pad');
        canvas.width = canvas.parentElement.offsetWidth; canvas.height = 150;
        const ctx = canvas.getContext('2d');
        const getP = (e) => {
            const r = canvas.getBoundingClientRect();
            return { x: (e.touches ? e.touches[0].clientX : e.clientX) - r.left, y: (e.touches ? e.touches[0].clientY : e.clientY) - r.top };
        };
        canvas.onmousedown = canvas.ontouchstart = (e) => { e.preventDefault(); this.drawing = true; const p = getP(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
        canvas.onmousemove = canvas.ontouchmove = (e) => { if(this.drawing) { const p = getP(e); ctx.lineTo(p.x, p.y); ctx.stroke(); } };
        canvas.onmouseup = canvas.ontouchend = () => this.drawing = false;
    },

    toggleMateriales: function() {
        const si = document.getElementById('rt-uso-materiales').value === 'si';
        document.getElementById('rt-seccion-materiales').classList.toggle('hidden', !si);
        this.calcularTotal();
    },

    agregarMaterial: function() {
        const opt = AppState.materiales.map(m => `<option value="${m.precio}">${m.nombre}</option>`).join('');
        const div = document.createElement('div');
        div.className = 'form-row';
        div.innerHTML = `<select class="mat-select" onchange="TicketModule.calcularTotal()" style="flex:2">${opt}</select>
                         <input type="number" class="mat-qty" value="1" onchange="TicketModule.calcularTotal()" style="width:60px">`;
        document.getElementById('rt-lista-materiales').appendChild(div);
        this.calcularTotal();
    },

    calcularTotal: function() {
        let t = document.getElementById('rt-tipo-visita').value === 'paga' ? 10 : 0;
        document.querySelectorAll('#rt-lista-materiales .form-row').forEach(r => {
            t += parseFloat(r.querySelector('.mat-select').value) * parseInt(r.querySelector('.mat-qty').value);
        });
        document.getElementById('rt-total-monto').innerText = t.toFixed(2);
    }
};

const UIModule = {
    navigate: async function(id) {
        document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
        document.getElementById(`view-${id}`).classList.remove('hidden');
        if(id === 'nuevo-ticket') TicketModule.prepararFormulario();
        if(id === 'dashboard-analista') {
            AppState.tickets = await API.tickets.getAnalista();
            this.renderAnalista();
        }
        if(id === 'dashboard-operaciones') {
            AppState.tickets = await API.tickets.getDisponibilidad(AuthModule.currentUser.nombre, '');
            this.renderOperaciones();
        }
    },
    renderAnalista: function() {
        const tbody = document.querySelector('#table-all-tickets tbody');
        tbody.innerHTML = AppState.tickets.map(t => `<tr><td>${t.id}</td><td>${t.Cliente_nombre}</td><td>${t.asignado_a}</td><td>${t.estado}</td><td>${t.fecha}</td><td>---</td></tr>`).join('');
    },
    renderOperaciones: function() {
        const tbody = document.querySelector('#table-op-tickets tbody');
        tbody.innerHTML = AppState.tickets.map(t => `<tr><td>${t.id}</td><td>${t.Cliente_nombre}</td><td>${t.hora}</td><td>${t.estado}</td><td><button onclick="TicketModule.abrirResolucion('${t.id}')">Gestionar</button></td></tr>`).join('');
    },
    toggleSidebar: () => document.getElementById('sidebar').classList.toggle('active')
};