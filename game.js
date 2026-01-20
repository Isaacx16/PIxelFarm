(() => {
  // ====== Config ======
  const CANVAS_W = 1280;
  const CANVAS_H = 720;

  const TILE_SIZE = 16;        // del tileset / mapa
  const SCALE = 4;             // estilo Stardew chunky
  const WORLD_TILE_PX = TILE_SIZE * SCALE;

  const SAVE_KEY = "stardew_like_save_v1";

  // IDs de tiles (según tu tileset/mapa)
  const TILE_TILLED = 4;

  // Cultivo: zanahoria por etapas
  // 0=empty, 1=seed, 2=sprout, 3=growing, 4=ready
  const CROP = {
    name: "carrot",
    stageMs: [0, 6000, 7000, 8000], // seed->sprout, sprout->growing, growing->ready
    harvest: { carrot: 1, coins: 2 }
  };

  // Solo puedes interactuar si estás cerca (en tiles)
  const INTERACT_RANGE_TILES = 2.2;

  // ====== DOM ======
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  ctx.imageSmoothingEnabled = false;

  const coinsEl = document.getElementById("coins");
  const carrotEl = document.getElementById("carrot");
  const saveStatusEl = document.getElementById("saveStatus");
  const resetBtn = document.getElementById("resetBtn");

  // ====== Assets ======
  const tileset = new Image();
  tileset.src = "./assets/tileset_16x16.png";

  // ====== State ======
  const keys = new Set();

  const state = {
    map: null,          // loaded JSON
    tilesetCols: 8,     // from JSON
    camera: { x: 0, y: 0 },
    player: {
      // en tiles (float)
      x: 18,
      y: 35,
      dir: "down",
      speed: 4.0, // tiles/sec
      w: 0.55,    // hitbox (tiles)
      h: 0.55
    },
    inv: { coins: 0, carrot: 0 },
    plots: new Map(), // key "x,y" -> { plantedAt, stage }
  };

  // ====== Helpers ======
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function tileKey(tx, ty){ return `${tx},${ty}`; }

  function worldToScreen(wx, wy){
    return {
      x: Math.floor(wx - state.camera.x),
      y: Math.floor(wy - state.camera.y)
    };
  }

  function isBlocked(tx, ty){
    const m = state.map;
    if (!m) return true;
    if (tx < 0 || ty < 0 || tx >= m.width || ty >= m.height) return true;
    return m.collision?.[ty]?.[tx] === 1;
  }

  function getTileId(tx, ty){
    const m = state.map;
    if (!m) return 0;
    if (tx < 0 || ty < 0 || tx >= m.width || ty >= m.height) return 0;
    return m.tiles[ty][tx];
  }

  function isTilled(tx, ty){
    return getTileId(tx, ty) === TILE_TILLED;
  }

  function distTiles(ax, ay, bx, by){
    return Math.hypot(ax - bx, ay - by);
  }

  function pingSave(msg){
    saveStatusEl.textContent = msg;
    clearTimeout(pingSave._t);
    pingSave._t = setTimeout(() => saveStatusEl.textContent = "OK", 800);
  }

  function updateHud(){
    coinsEl.textContent = String(state.inv.coins);
    carrotEl.textContent = String(state.inv.carrot);
  }

  // ====== Save/Load ======
  function save(){
    try{
      const data = {
        inv: state.inv,
        player: { x: state.player.x, y: state.player.y, dir: state.player.dir },
        plots: Array.from(state.plots.entries())
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      pingSave("OK");
    }catch{
      pingSave("ERR");
    }
  }

  function load(){
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return;
    try{
      const data = JSON.parse(raw);
      if (data?.inv){
        state.inv.coins = data.inv.coins || 0;
        state.inv.carrot = data.inv.carrot || 0;
      }
      if (data?.player){
        state.player.x = data.player.x ?? state.player.x;
        state.player.y = data.player.y ?? state.player.y;
        state.player.dir = data.player.dir || "down";
      }
      if (Array.isArray(data?.plots)){
        state.plots = new Map(data.plots);
      }
    }catch{
      // ignore
    }
  }

  resetBtn.addEventListener("click", () => {
    localStorage.removeItem(SAVE_KEY);
    location.reload();
  });

  // ====== Input ======
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (["w","a","s","d","arrowup","arrowleft","arrowdown","arrowright"].includes(k)){
      keys.add(k);
      e.preventDefault();
    }
  }, { passive:false });

  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

  canvas.addEventListener("click", (e) => {
    if (!state.map) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const my = (e.clientY - rect.top) * (canvas.height / rect.height);

    // convertir screen -> world pixels -> tile coords
    const worldX = mx + state.camera.x;
    const worldY = my + state.camera.y;
    const tx = Math.floor(worldX / WORLD_TILE_PX);
    const ty = Math.floor(worldY / WORLD_TILE_PX);

    handleFarmClick(tx, ty);
  });

  function handleFarmClick(tx, ty){
    // Solo en tierra arada
    if (!isTilled(tx, ty)) return;

    // Debes estar cerca
    const d = distTiles(state.player.x, state.player.y, tx + 0.5, ty + 0.5);
    if (d > INTERACT_RANGE_TILES) return;

    const key = tileKey(tx, ty);
    const now = Date.now();
    const plot = state.plots.get(key);

    // Si no existe, está vacío
    if (!plot){
      // sembrar
      state.plots.set(key, { plantedAt: now, stage: 1 }); // seed
      save();
      return;
    }

    // Si está listo, cosechar
    if (plot.stage === 4){
      state.inv.carrot += CROP.harvest.carrot;
      state.inv.coins += CROP.harvest.coins;
      state.plots.delete(key);
      updateHud();
      save();
      return;
    }

    // si está creciendo, no hacemos nada (luego se puede permitir regar, etc.)
  }

  // ====== Loading map ======
  async function loadMap(){
    const res = await fetch("./data/map_base.json");
    const m = await res.json();
    state.map = m;
    state.tilesetCols = m.tilesetCols || 8;

    // Spawn desde JSON si existe
    if (m.spawn){
      state.player.x = m.spawn.x;
      state.player.y = m.spawn.y;
    }
  }

  // ====== Drawing ======
  function drawMap(){
    const m = state.map;
    if (!m) return;

    // tiles visibles
    const tilesAcross = Math.ceil(CANVAS_W / WORLD_TILE_PX) + 2;
    const tilesDown   = Math.ceil(CANVAS_H / WORLD_TILE_PX) + 2;

    const camTileX = Math.floor(state.camera.x / WORLD_TILE_PX);
    const camTileY = Math.floor(state.camera.y / WORLD_TILE_PX);

    for (let y = 0; y < tilesDown; y++){
      for (let x = 0; x < tilesAcross; x++){
        const tx = camTileX + x;
        const ty = camTileY + y;
        if (tx < 0 || ty < 0 || tx >= m.width || ty >= m.height) continue;

        const id = m.tiles[ty][tx];
        const sx = (id % state.tilesetCols) * TILE_SIZE;
        const sy = Math.floor(id / state.tilesetCols) * TILE_SIZE;

        const wx = tx * WORLD_TILE_PX;
        const wy = ty * WORLD_TILE_PX;
        const p = worldToScreen(wx, wy);

        ctx.drawImage(
          tileset,
          sx, sy, TILE_SIZE, TILE_SIZE,
          p.x, p.y, WORLD_TILE_PX, WORLD_TILE_PX
        );
      }
    }
  }

  function drawPlayer(){
    // sprite placeholder pixel art (procedural) en world tiles
    const wx = state.player.x * WORLD_TILE_PX;
    const wy = state.player.y * WORLD_TILE_PX;
    const p = worldToScreen(wx, wy);

    // sombra
    ctx.fillStyle = "rgba(0,0,0,.25)";
    ctx.fillRect(p.x + 12, p.y + 44, 40, 10);

    // cuerpo estilo pixel
    // cabeza
    ctx.fillStyle = "#f1c7a6";
    ctx.fillRect(p.x + 22, p.y + 12, 20, 20);
    // pelo
    ctx.fillStyle = "#2a1f1a";
    ctx.fillRect(p.x + 22, p.y + 10, 20, 6);
    // camisa
    ctx.fillStyle = "#3aa0ff";
    ctx.fillRect(p.x + 18, p.y + 32, 28, 20);
    // pantalón
    ctx.fillStyle = "#2b3a55";
    ctx.fillRect(p.x + 18, p.y + 52, 28, 12);

    // nariz según dirección (mini detalle)
    ctx.fillStyle = "#e6b493";
    if (state.player.dir === "left") ctx.fillRect(p.x + 18, p.y + 24, 4, 4);
    if (state.player.dir === "right") ctx.fillRect(p.x + 42, p.y + 24, 4, 4);
    if (state.player.dir === "down") ctx.fillRect(p.x + 30, p.y + 32, 4, 4);
    if (state.player.dir === "up") ctx.fillRect(p.x + 30, p.y + 12, 4, 4);
  }

  function drawCropAtTile(tx, ty, plot){
    // Dibujamos el cultivo encima del tile (pixel art simple)
    const wx = tx * WORLD_TILE_PX;
    const wy = ty * WORLD_TILE_PX;
    const p = worldToScreen(wx, wy);

    // base overlay (suave)
    ctx.fillStyle = "rgba(0,0,0,.08)";
    ctx.fillRect(p.x + 6, p.y + 6, WORLD_TILE_PX - 12, WORLD_TILE_PX - 12);

    // según etapa, dibujar distinto
    // coordenadas dentro del tile
    const ox = p.x;
    const oy = p.y;

    if (plot.stage === 1){
      // seed
      ctx.fillStyle = "#2b1d14";
      ctx.fillRect(ox + 30, oy + 44, 8, 6);
    } else if (plot.stage === 2){
      // sprout
      ctx.fillStyle = "#2fcf62";
      ctx.fillRect(ox + 32, oy + 38, 6, 10);
      ctx.fillStyle = "#7cffb0";
      ctx.fillRect(ox + 31, oy + 36, 8, 3);
    } else if (plot.stage === 3){
      // growing plant
      ctx.fillStyle = "#2fcf62";
      ctx.fillRect(ox + 26, oy + 30, 20, 18);
      ctx.fillStyle = "#7cffb0";
      ctx.fillRect(ox + 28, oy + 28, 16, 4);
    } else if (plot.stage === 4){
      // ready (zanahoria)
      ctx.fillStyle = "#36d86c"; // hojas
      ctx.fillRect(ox + 26, oy + 24, 20, 10);
      ctx.fillStyle = "#ff7a2f"; // raíz
      ctx.fillRect(ox + 32, oy + 34, 8, 22);
      ctx.fillStyle = "#d85e22";
      ctx.fillRect(ox + 32, oy + 52, 8, 4);

      // brillo “listo”
      ctx.fillStyle = "rgba(124,245,182,.35)";
      ctx.fillRect(ox + 10, oy + 10, 10, 10);
    }
  }

  function drawCrops(){
    // Dibujar solo plots visibles (optimizado)
    const tilesAcross = Math.ceil(CANVAS_W / WORLD_TILE_PX) + 2;
    const tilesDown   = Math.ceil(CANVAS_H / WORLD_TILE_PX) + 2;
    const camTileX = Math.floor(state.camera.x / WORLD_TILE_PX);
    const camTileY = Math.floor(state.camera.y / WORLD_TILE_PX);

    for (let y = camTileY; y < camTileY + tilesDown; y++){
      for (let x = camTileX; x < camTileX + tilesAcross; x++){
        const key = tileKey(x, y);
        const plot = state.plots.get(key);
        if (plot) drawCropAtTile(x, y, plot);
      }
    }
  }

  function drawUIHint(){
    // mini hint sobre el jugador: “click para sembrar” si está cerca de un tile arado
    const px = state.player.x;
    const py = state.player.y;

    // buscar tile arado cercano
    let best = null;
    for (let ty = Math.floor(py - 2); ty <= Math.floor(py + 2); ty++){
      for (let tx = Math.floor(px - 2); tx <= Math.floor(px + 2); tx++){
        if (!isTilled(tx, ty)) continue;
        const d = distTiles(px, py, tx + 0.5, ty + 0.5);
        if (d <= INTERACT_RANGE_TILES && (!best || d < best.d)){
          best = { tx, ty, d };
        }
      }
    }

    if (!best) return;

    const key = tileKey(best.tx, best.ty);
    const plot = state.plots.get(key);

    let msg = "Click: sembrar";
    if (plot?.stage === 4) msg = "Click: cosechar";
    else if (plot) msg = "Creciendo...";

    ctx.font = "16px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.fillStyle = "rgba(0,0,0,.55)";
    ctx.fillRect(16, 16, ctx.measureText(msg).width + 18, 30);
    ctx.fillStyle = "#e9eeff";
    ctx.fillText(msg, 24, 38);
  }

  // ====== Farming logic (stage updates) ======
  function updatePlots(){
    const now = Date.now();
    for (const [k, plot] of state.plots.entries()){
      if (plot.stage >= 4) continue;

      const elapsed = now - plot.plantedAt;
      const t1 = CROP.stageMs[1];
      const t2 = t1 + CROP.stageMs[2];
      const t3 = t2 + CROP.stageMs[3];

      if (elapsed < t1) plot.stage = 1;
      else if (elapsed < t2) plot.stage = 2;
      else if (elapsed < t3) plot.stage = 3;
      else plot.stage = 4;
    }
  }

  // ====== Movement & collision ======
  function tryMove(dx, dy, dt){
    const p = state.player;
    const nx = p.x + dx * p.speed * dt;
    const ny = p.y + dy * p.speed * dt;

    // colisión simple por tile: probar eje por eje
    // X
    let tx = Math.floor(nx);
    let ty = Math.floor(p.y);
    if (!isBlocked(tx, ty)) p.x = nx;

    // Y
    tx = Math.floor(p.x);
    ty = Math.floor(ny);
    if (!isBlocked(tx, ty)) p.y = ny;

    // límites mapa
    const m = state.map;
    if (m){
      p.x = clamp(p.x, 0.2, m.width - 1.2);
      p.y = clamp(p.y, 0.2, m.height - 1.2);
    }
  }

  function updateCamera(){
    const m = state.map;
    if (!m) return;

    // centrar en jugador
    const targetX = state.player.x * WORLD_TILE_PX - CANVAS_W / 2 + WORLD_TILE_PX / 2;
    const targetY = state.player.y * WORLD_TILE_PX - CANVAS_H / 2 + WORLD_TILE_PX / 2;

    // clamp a límites del mundo
    const worldW = m.width * WORLD_TILE_PX;
    const worldH = m.height * WORLD_TILE_PX;

    state.camera.x = clamp(targetX, 0, Math.max(0, worldW - CANVAS_W));
    state.camera.y = clamp(targetY, 0, Math.max(0, worldH - CANVAS_H));
  }

  // ====== Loop ======
  let last = performance.now();
  function loop(t){
    const dt = (t - last) / 1000;
    last = t;

    // movement input
    let dx = 0, dy = 0;
    if (keys.has("w") || keys.has("arrowup")) { dy -= 1; state.player.dir = "up"; }
    if (keys.has("s") || keys.has("arrowdown")) { dy += 1; state.player.dir = "down"; }
    if (keys.has("a") || keys.has("arrowleft")) { dx -= 1; state.player.dir = "left"; }
    if (keys.has("d") || keys.has("arrowright")) { dx += 1; state.player.dir = "right"; }

    if (dx !== 0 || dy !== 0){
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      tryMove(dx, dy, dt);
    }

    updatePlots();
    updateCamera();
    render();

    requestAnimationFrame(loop);
  }

  function render(){
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    if (!state.map || !tileset.complete) return;

    drawMap();
    drawCrops();     // 👈 cultivos encima del suelo
    drawPlayer();
    drawUIHint();

    // borde
    ctx.strokeStyle = "rgba(255,255,255,.08)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, CANVAS_W-2, CANVAS_H-2);
  }

  // ====== Init ======
  async function init(){
    await loadMap();
    load();
    updateHud();

    // autosave cada 5s
    setInterval(save, 5000);

    // guardar inicial
    save();
    requestAnimationFrame(loop);
  }

  init();
})();

