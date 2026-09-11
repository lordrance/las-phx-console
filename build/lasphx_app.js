(function(){
  "use strict";

  const MAP_DATA = JSON.parse(document.getElementById('mapdata').textContent);
  const ZIP_GEO  = JSON.parse(document.getElementById('zipgeo').textContent);

  const STATIONS    = MAP_DATA.stations;
  const DSP_SUMMARY = MAP_DATA.dsp_summary;
  const STATION_KEYS = Object.keys(STATIONS).sort(
    (a,b)=>STATIONS[b].total_volume-STATIONS[a].total_volume);
  const DSP_KEYS = Object.keys(DSP_SUMMARY).sort();

  // assigned by volume rank so the busiest stations get the most legible hues
  const STATION_COLORS = {
    PHX01:'#2DD9C6', LAS01:'#F2A93B', TUC01:'#FF6B6B', STG01:'#8B7FF0',
    IFP01:'#4FB6FF', PRC01:'#A3D65C', CGZ01:'#FF8FC7', FLG01:'#E0C341'
  };
  const DSP_PALETTE = ['#2DD9C6','#F2A93B','#FF6B6B','#8B7FF0','#4FB6FF','#A3D65C',
                       '#FF8FC7','#6E7FDB','#E0C341','#46C99A','#E8734A','#7FA5C9',
                       '#C87FEA','#D9A05B','#5BC0BE'];
  const DSP_COLORS = {};
  DSP_KEYS.forEach((d,i)=> DSP_COLORS[d] = DSP_PALETTE[i % DSP_PALETTE.length]);

  // 邮编难易度: A 难 -> D 极易. Only LAS01 and TUC01 carry grades in the source.
  const GRADE_KEYS   = ['A','B','C','D'];
  const GRADE_COLORS = {A:'#E0553F', B:'#F2A93B', C:'#7FC96B', D:'#2E9E6B'};
  const GRADE_LABELS = {A:'A 级 · 难', B:'B 级 · 中', C:'C 级 · 易', D:'D 级 · 极易'};
  const NO_GRADE_FILL = '#33405C';

  function routeColor(idx){
    const hue = (idx * 137.508) % 360;           // golden-angle hue rotation
    return `hsl(${hue.toFixed(1)}, 68%, 58%)`;
  }
  const ROUTE_COLORS = {};
  STATION_KEYS.forEach(st=>{
    const routes = STATIONS[st].routes.slice().sort((a,b)=>a.route.localeCompare(b.route));
    ROUTE_COLORS[st] = {};
    routes.forEach((r,i)=>{ ROUTE_COLORS[st][r.route] = routeColor(i); });
  });

  // ---------- Flat zip index (one station / route / DSP per zip in this region) ----------
  const ZIP_INDEX = {};
  STATION_KEYS.forEach(st=>{
    STATIONS[st].zips.forEach(z=>{
      let domDsp=null, domVol=-1;
      Object.entries(z.dsps).forEach(([d,v])=>{ if(v>domVol){domVol=v; domDsp=d;} });
      let domRoute=null, domRouteVol=-1;
      Object.entries(z.routes).forEach(([rt,v])=>{ if(v>domRouteVol){domRouteVol=v; domRoute=rt;} });
      ZIP_INDEX[z.zip] = {
        zip:z.zip, station:st, volume:z.volume, price:z.price,
        dsps:z.dsps, routes:z.routes, fleet:z.fleet,
        has_geom:z.has_geom, lat:z.lat, lon:z.lon, coord_source:z.coord_source,
        grade:z.grade, grade_label:z.grade_label, pph:z.pph,
        dominantDsp:domDsp, dominantRoute:domRoute
      };
    });
  });

  const ALL_VOLUMES = Object.values(ZIP_INDEX).map(z=>z.volume).filter(v=>v>0);
  const ALL_PRICES  = Object.values(ZIP_INDEX).map(z=>z.price).filter(p=>p>0);
  const VOL_MIN = Math.min(...ALL_VOLUMES),  VOL_MAX = Math.max(...ALL_VOLUMES);
  const PRICE_MIN = Math.min(...ALL_PRICES), PRICE_MAX = Math.max(...ALL_PRICES);

  const VOL_RAMP   = ['#FEF3C7','#FDE68A','#FBBF6D','#F59E4C','#E8622F','#C23A2A','#8E1F1F'];
  const PRICE_RAMP = ['#E9EFFD','#C7D6F7','#9FB6EE','#7191DE','#5A6FC9','#4C4FA8','#3A2E7A'];

  function rampColor(val, min, max, ramp){
    if(max<=min) return ramp[0];
    let t = Math.max(0, Math.min(1,(val-min)/(max-min)));
    return ramp[Math.min(ramp.length-1, Math.floor(t*ramp.length))];
  }

  // region extent, used for the initial frame and Reset view
  const REGION_BOUNDS = (()=>{
    const pts = Object.values(ZIP_INDEX).filter(z=>z.lat&&z.lon).map(z=>[z.lat,z.lon]);
    STATION_KEYS.forEach(s=>{ const i=STATIONS[s]; if(i.lat&&i.lon) pts.push([i.lat,i.lon]); });
    return L.latLngBounds(pts);
  })();

  // ---------- State ----------
  const defaultFocus = STATION_KEYS[0];
  const state = {
    view:'station', focusRoute:null,
    activeStations:new Set(), activeDsps:new Set(),
    focusStation:defaultFocus
  };

  // ---------- Map ----------
  const map = L.map('map', {zoomControl:false, minZoom:5, maxZoom:13});
  map.fitBounds(REGION_BOUNDS, {padding:[40,40]});
  L.control.zoom({position:'bottomleft'}).addTo(map);

  // Basemap choice is constrained by one thing: openstreetmap.org refuses tiles
  // to requests that carry no Referer header, and that is exactly what a browser
  // sends when the page is opened straight off disk (file://) -- every tile comes
  // back as an "Access blocked" notice. Esri's services have no such rule, so the
  // colourful Esri street map is the default and the file works both deployed and
  // double-clicked. Plain OSM stays available for anyone who prefers it once the
  // page is served over http(s).
  const ARC = 'https://server.arcgisonline.com/ArcGIS/rest/services/'
            + '{svc}/MapServer/tile/{z}/{y}/{x}';
  const esri = (svc, opts) => L.tileLayer(ARC.replace('{svc}', svc),
    Object.assign({attribution:'Tiles &copy; Esri', maxZoom:16}, opts||{}));

  // Esri's Canvas basemaps ship imagery and place labels as separate services.
  // The label layer goes in its own pane above the zip polygons (overlayPane,
  // 400) but below the station markers (600), so city names stay readable
  // through the semi-transparent fills.
  map.createPane('labels');
  map.getPane('labels').style.zIndex = 450;
  map.getPane('labels').style.pointerEvents = 'none';

  const BASEMAPS = {
    '彩色街道图': {
      layer: esri('World_Street_Map'),
      dark: false
    },
    '彩色地形图': {
      layer: esri('World_Topo_Map'),
      dark: false
    },
    '深色 Dark': {
      layer: L.layerGroup([esri('Canvas/World_Dark_Gray_Base'),
                           esri('Canvas/World_Dark_Gray_Reference', {pane:'labels'})]),
      dark: true
    },
    '卫星影像': {
      layer: esri('World_Imagery'),
      dark: true
    },
    'OSM 标准 (需 http)': {
      layer: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution:'&copy; OpenStreetMap contributors', subdomains:'abc', maxZoom:19}),
      dark: false
    }
  };
  let darkBase = false;                      // drives the zip outline colour
  const DEFAULT_BASEMAP = '彩色街道图';
  BASEMAPS[DEFAULT_BASEMAP].layer.addTo(map);
  L.control.layers(
    Object.fromEntries(Object.entries(BASEMAPS).map(([k,v])=>[k, v.layer])),
    null, {position:'bottomleft', collapsed:true}
  ).addTo(map);
  map.on('baselayerchange', e=>{
    const hit = BASEMAPS[e.name];
    if(!hit) return;
    darkBase = hit.dark;
    buildZipLayer();
  });

  // zip outlines need to invert with the basemap or they vanish
  const zipStroke = () => darkBase ? 'rgba(233,238,249,.30)' : '#0A101E';

  let zipLayer = null;
  const markerLayer     = L.layerGroup().addTo(map);
  const highlightLayer  = L.layerGroup().addTo(map);
  const routeLabelLayer = L.layerGroup().addTo(map);

  const fmt = n => Math.round(n).toLocaleString('en-US');
  const fmtPrice = n => '$'+n.toFixed(2);
  const stationOn = s => state.activeStations.size===0 || state.activeStations.has(s);
  const dspOn     = d => state.activeDsps.size===0     || state.activeDsps.has(d);

  // per-station DSP share of volume, descending
  const STATION_DSP = {};
  STATION_KEYS.forEach(s=>{
    const zips = STATIONS[s].zips;
    const tot = STATIONS[s].total_volume || zips.reduce((a,z)=>a+z.volume,0);
    const byDsp = {};
    zips.forEach(z=>Object.entries(z.dsps).forEach(([d,v])=>{ byDsp[d]=(byDsp[d]||0)+v; }));
    let arr;
    if(tot>0){ arr = Object.entries(byDsp).map(([d,v])=>({dsp:d, vol:v, pct:v/tot*100})); }
    else {
      const cnt={}; zips.forEach(z=>Object.keys(z.dsps).forEach(d=>cnt[d]=(cnt[d]||0)+1));
      const zc = zips.length||1;
      arr = Object.entries(cnt).map(([d,c])=>({dsp:d, vol:0, pct:c/zc*100}));
    }
    arr.sort((a,b)=>b.pct-a.pct);
    STATION_DSP[s]=arr;
  });

  // grade rollup for the Difficulty view
  const GRADE_STATS = {};
  GRADE_KEYS.concat(['?']).forEach(g=>GRADE_STATS[g]={zips:0, volume:0, pphSum:0, pphN:0, priceSum:0, priceVol:0});
  Object.values(ZIP_INDEX).forEach(z=>{
    const g = z.grade || '?';
    const s = GRADE_STATS[g];
    s.zips++; s.volume += z.volume;
    if(z.pph){ s.pphSum += z.pph; s.pphN++; }
    if(z.price>0){ s.priceSum += z.price*z.volume; s.priceVol += z.volume; }
  });
  const GRADED_ZIPS = GRADE_KEYS.reduce((a,g)=>a+GRADE_STATS[g].zips, 0);

  // ---------- Zip styling ----------
  function zipStyleFor(rec){
    let fill = '#888';
    if(state.view==='station')      fill = STATION_COLORS[rec.station] || '#888';
    else if(state.view==='dsp')     fill = DSP_COLORS[rec.dominantDsp] || '#888';
    else if(state.view==='routes')  fill = (ROUTE_COLORS[rec.station]||{})[rec.dominantRoute] || '#888';
    else if(state.view==='volume')  fill = rampColor(rec.volume, VOL_MIN, VOL_MAX, VOL_RAMP);
    else if(state.view==='price')   fill = rec.price>0 ? rampColor(rec.price, PRICE_MIN, PRICE_MAX, PRICE_RAMP) : '#333';
    else if(state.view==='grade')   fill = rec.grade ? GRADE_COLORS[rec.grade] : NO_GRADE_FILL;
    return {fill};
  }

  function isVisible(rec){
    if(state.view==='routes') return rec.station === state.focusStation;
    return stationOn(rec.station) && dspOn(rec.dominantDsp);
  }

  function styleFeature(feature){
    const rec = ZIP_INDEX[feature.properties.zip];
    if(!rec || !isVisible(rec)) return {fillOpacity:0, opacity:0, weight:0, interactive:false};
    const {fill} = zipStyleFor(rec);
    const stroke = zipStroke();
    if(state.view==='routes' && state.focusRoute){
      if(rec.dominantRoute === state.focusRoute)
        return {color:'#ffffff', weight:1.8, fillColor:fill, fillOpacity:0.88, opacity:0.95};
      return {color:stroke, weight:0.6, fillColor:fill, fillOpacity:0.14, opacity:0.3};
    }
    // ungraded zips stay deliberately faint in the Difficulty view
    if(state.view==='grade' && !rec.grade)
      return {color:stroke, weight:0.6, fillColor:fill, fillOpacity:0.22, opacity:0.4};
    return {color:stroke, weight:0.9, fillColor:fill, fillOpacity:0.62, opacity:0.7};
  }

  function gradeChip(rec){
    if(!rec.grade) return '<span class="pop-dsp-badge" style="opacity:.6">难易度未评级</span>';
    const c = GRADE_COLORS[rec.grade];
    return `<span class="pop-dsp-badge" style="border-color:${c};color:${c}">${GRADE_LABELS[rec.grade]}`
         + (rec.pph ? ` · PPH ${rec.pph}` : '') + `</span>`;
  }

  function zipPopupHtml(rec){
    const dspRows = Object.entries(rec.dsps).sort((a,b)=>b[1]-a[1])
      .map(([d,v])=>`<span class="pop-dsp-badge" style="border-color:${DSP_COLORS[d]}66">${d} · ${fmt(v)}</span>`).join('');
    const routeEntries = Object.entries(rec.routes).sort((a,b)=>b[1]-a[1]);
    const rcolors = ROUTE_COLORS[rec.station] || {};
    const routesHtml = routeEntries.length ? routeEntries.map(([rt,v])=>
      `<div style="display:flex;align-items:center;gap:6px;padding:2px 0;"><span style="width:7px;height:7px;border-radius:50%;background:${rcolors[rt]||'#888'};flex:none;"></span><span style="flex:1;">${rt}</span><span class="mono" style="color:var(--muted);">${fmt(v)}</span></div>`
    ).join('') : '—';
    const geomNote = rec.has_geom ? '' :
      `<div class="pop-note">⬤ 该邮编无 ZCTA 边界数据(多为 PO Box 专用邮编),位置取所属站点服务区中心</div>`;
    return `
      <div class="pop-title"><span style="color:${STATION_COLORS[rec.station]}">●</span> ZIP ${rec.zip}</div>
      <div class="pop-sub">${rec.station} · DSP ${rec.dominantDsp||'—'} · 车队 ${rec.fleet||'—'} · 线路 ${rec.dominantRoute||'—'}</div>
      <div class="pop-grid">
        <div class="pop-stat"><div class="v">${fmt(rec.volume)}</div><div class="l">Daily Volume</div></div>
        <div class="pop-stat"><div class="v">${rec.price>0?fmtPrice(rec.price):'—'}</div><div class="l">首票价格</div></div>
      </div>
      <div class="pop-dsplist">${dspRows}${gradeChip(rec)}</div>
      <div class="pop-addr">线路 (${routeEntries.length}):<div class="pop-route-scroll">${routesHtml}</div></div>
      ${geomNote}
    `;
  }

  function buildZipLayer(){
    if(zipLayer) map.removeLayer(zipLayer);
    zipLayer = L.geoJSON(ZIP_GEO, {
      style: styleFeature,
      onEachFeature:(feature, layer)=>{
        const rec = ZIP_INDEX[feature.properties.zip];
        if(!rec) return;
        layer.on('mouseover', function(e){
          if(!isVisible(rec)) return;
          layer.setStyle({weight:2, color:'#fff', fillOpacity:0.9});
          const extra = state.view==='grade'
            ? ` · ${rec.grade ? GRADE_LABELS[rec.grade] + (rec.pph?` PPH ${rec.pph}`:'') : '未评级'}`
            : '';
          layer.bindTooltip(
            `<b>${rec.zip}</b> · ${rec.station} · ${rec.dominantDsp||'—'} · ${rec.dominantRoute||'—'} · ${fmt(rec.volume)}/day · ${rec.price>0?fmtPrice(rec.price):'—'}${extra}`,
            {className:'zip-tooltip', sticky:true}
          ).openTooltip(e.latlng);
        });
        layer.on('mouseout', ()=> zipLayer.resetStyle(layer));
        layer.on('click', function(e){
          if(!isVisible(rec)) return;
          L.popup({maxWidth:290}).setLatLng(e.latlng).setContent(zipPopupHtml(rec)).openOn(map);
        });
      }
    }).addTo(map);
  }

  // ---------- Route number labels (Routes view) ----------
  function routeShortLabel(routeName){
    if(!routeName) return '—';
    const parts = routeName.split('-');
    return parts.length>1 ? parts[parts.length-1].replace(/^0+(?=\d)/,'') : routeName;
  }

  function buildRouteLabels(){
    routeLabelLayer.clearLayers();
    if(state.view !== 'routes') return;
    if(map.getZoom() < 8) return;
    const rcolors = ROUTE_COLORS[state.focusStation] || {};
    Object.values(ZIP_INDEX).forEach(rec=>{
      if(rec.station !== state.focusStation) return;
      if(!rec.has_geom || !rec.lat || !rec.lon) return;
      const short = routeShortLabel(rec.dominantRoute);
      const color = rcolors[rec.dominantRoute] || '#fff';
      const icon = L.divIcon({className:'',
        html:`<div class="route-label" style="color:${color};" title="${rec.dominantRoute}">${short}</div>`,
        iconSize:[0,0], iconAnchor:[0,0]});
      L.marker([rec.lat, rec.lon], {icon, interactive:false, keyboard:false}).addTo(routeLabelLayer);
    });
  }
  map.on('zoomend', ()=>{ if(state.view==='routes') buildRouteLabels(); });

  // ---------- Station markers ----------
  function stationRadius(vol){
    const maxVol = Math.max(...STATION_KEYS.map(s=>STATIONS[s].total_volume));
    return 16 + (vol/maxVol)*20;
  }

  function stationIcon(st){
    const info = STATIONS[st];
    const size = stationRadius(info.total_volume);
    return L.divIcon({className:'',
      html:`<div style="position:relative;">
              <div class="station-badge" style="width:${size}px;height:${size}px;background:${STATION_COLORS[st]};font-size:${Math.max(9,size*0.28)}px;">${st}</div>
            </div>`,
      iconSize:[size,size], iconAnchor:[size/2,size/2]});
  }

  function stationPopupHtml(st){
    const info = STATIONS[st];
    const dspBadges = info.dsps.map(d=>`<span class="pop-dsp-badge" style="border-color:${DSP_COLORS[d]}66">${d}</span>`).join('');
    const selfRun = !/自营\/Self-Operated|DSP自营/.test(info.head||'');
    return `
      <div class="pop-title"><span style="color:${STATION_COLORS[st]}">●</span> ${st} 站点</div>
      <div class="pop-sub">${info.zip_count} 个邮编 · ${info.dsps.length} 家 DSP · ${info.routes.length} 条线路</div>
      <div class="pop-specialist">
        <div class="ic">${(info.head||'?').toString().slice(0,1)}</div>
        <div><b>${info.head||'未分配'}</b><br><span style="color:var(--muted);font-size:10.5px;">${selfRun?'站点负责人 / Station Head':'运营方式 / Operating Model'}</span></div>
      </div>
      <div class="pop-grid">
        <div class="pop-stat"><div class="v">${fmt(info.total_volume)}</div><div class="l">Daily Volume</div></div>
        <div class="pop-stat"><div class="v">${fmtPrice(info.avg_price)}</div><div class="l">加权均价</div></div>
      </div>
      <div class="pop-dsplist">${dspBadges}</div>
      <div class="pop-addr">${info.address||'地址待补'}</div>
    `;
  }

  function buildMarkers(){
    markerLayer.clearLayers();
    STATION_KEYS.forEach(st=>{
      const info = STATIONS[st];
      if(!info.lat || !info.lon) return;
      if(!stationOn(st)) return;
      const m = L.marker([info.lat, info.lon], {icon: stationIcon(st), zIndexOffset:1000});
      m.bindPopup(stationPopupHtml(st), {maxWidth:300});
      m.on('click', ()=> highlightStation(st));
      m.addTo(markerLayer);
    });
  }

  function highlightStation(st){
    highlightLayer.clearLayers();
    const info = STATIONS[st];
    const bounds = [];
    info.zips.forEach(z=>{ if(z.lat&&z.lon) bounds.push([z.lat,z.lon]); });
    if(info.lat && info.lon) bounds.push([info.lat, info.lon]);
    if(bounds.length) map.flyToBounds(bounds, {padding:[80,80], maxZoom:10, duration:0.6});
  }

  // ---------- Legend ----------
  function renderLegend(){
    const el = document.getElementById('legend');
    if(state.view==='routes'){ el.style.display='none'; return; }
    el.style.display = '';
    if(state.view==='station'){
      el.innerHTML = `<div class="lg-title">站点 / Station</div>` +
        STATION_KEYS.filter(s=>stationOn(s)).map(s=>
          `<div class="lg-cat"><span class="sw" style="background:${STATION_COLORS[s]}"></span>${s} · ${fmt(STATIONS[s].total_volume)}/d</div>`).join('');
    } else if(state.view==='dsp'){
      el.innerHTML = `<div class="lg-title">每个邮编的 DSP</div>` +
        DSP_KEYS.filter(d=>dspOn(d)).map(d=>
          `<div class="lg-cat"><span class="sw" style="background:${DSP_COLORS[d]}"></span>${d} · ${fmt(DSP_SUMMARY[d].volume)}/d</div>`).join('');
    } else if(state.view==='volume'){
      el.innerHTML = `<div class="lg-title">日均单量 / 邮编</div>
        <div class="lg-grad" style="background:linear-gradient(90deg, ${VOL_RAMP.join(',')})"></div>
        <div class="lg-scale-labels"><span>${fmt(VOL_MIN)}</span><span>${fmt(VOL_MAX)}</span></div>`;
    } else if(state.view==='price'){
      el.innerHTML = `<div class="lg-title">首票价格 / 邮编</div>
        <div class="lg-grad" style="background:linear-gradient(90deg, ${PRICE_RAMP.join(',')})"></div>
        <div class="lg-scale-labels"><span>${fmtPrice(PRICE_MIN)}</span><span>${fmtPrice(PRICE_MAX)}</span></div>`;
    } else if(state.view==='grade'){
      el.innerHTML = `<div class="lg-title">邮编难易度</div>` +
        GRADE_KEYS.filter(g=>GRADE_STATS[g].zips>0).map(g=>{
          const s = GRADE_STATS[g];
          const pph = s.pphN ? ` · PPH ${(s.pphSum/s.pphN).toFixed(1)}` : '';
          return `<div class="lg-cat"><span class="sw" style="background:${GRADE_COLORS[g]}"></span>${GRADE_LABELS[g]} · ${s.zips}个${pph}</div>`;
        }).join('') +
        `<div class="lg-cat" style="opacity:.6"><span class="sw" style="background:${NO_GRADE_FILL}"></span>未评级 · ${GRADE_STATS['?'].zips}个</div>
         <div class="lg-foot">仅 LAS01 / TUC01 的 ${GRADED_ZIPS} 个邮编有评级</div>`;
    }
  }

  // ---------- Route panel ----------
  function renderRoutePanel(){
    const panel = document.getElementById('route-panel');
    if(state.view !== 'routes'){ panel.style.display='none'; return; }
    panel.style.display = 'flex';
    document.getElementById('rp-station-label').textContent = `· ${state.focusStation}`;
    const info = STATIONS[state.focusStation];
    const rcolors = ROUTE_COLORS[state.focusStation] || {};
    const list = document.getElementById('rp-list');
    list.innerHTML = info.routes.slice()
      .sort((a,b)=>a.route.localeCompare(b.route,undefined,{numeric:true})).map(r=>`
        <div class="rp-chip" data-route="${r.route}">
          <span class="sw" style="background:${rcolors[r.route]||'#888'}"></span>
          <span>${r.route}</span><span class="rv">${fmt(r.volume)}</span>
        </div>`).join('');
    list.querySelectorAll('.rp-chip').forEach(c=>{
      const rt = c.getAttribute('data-route');
      if(rt === state.focusRoute) c.classList.add('active');
      c.addEventListener('click', ()=>{
        state.focusRoute = (state.focusRoute === rt) ? null : rt;
        list.querySelectorAll('.rp-chip').forEach(x=>
          x.classList.toggle('active', x.getAttribute('data-route')===state.focusRoute));
        buildZipLayer(); buildRouteLabels();
        if(state.focusRoute){
          const pts = [];
          Object.values(ZIP_INDEX).forEach(z=>{
            if(z.station===state.focusStation && z.dominantRoute===rt && z.lat && z.lon) pts.push([z.lat,z.lon]);
          });
          if(pts.length) map.flyToBounds(pts, {padding:[60,60], maxZoom:11, duration:0.6});
        }
      });
    });
  }

  function renderRouteFocusChips(){
    const section = document.getElementById('route-focus-section');
    if(state.view !== 'routes'){ section.style.display='none'; return; }
    section.style.display = '';
    const el = document.getElementById('route-focus-chips');
    el.innerHTML = STATION_KEYS.map(s=>{
      const on = s === state.focusStation;
      return `<div class="chip ${on?'':'off'}" data-focus="${s}"><span class="sw" style="background:${STATION_COLORS[s]}"></span>${s} <span style="color:var(--muted-2)">(${STATIONS[s].routes.length})</span></div>`;
    }).join('');
    el.querySelectorAll('.chip').forEach(c=>{
      c.addEventListener('click', ()=>{
        state.focusStation = c.getAttribute('data-focus');
        state.focusRoute = null;
        refreshAll();
        highlightStation(state.focusStation);
      });
    });
  }

  // ---------- Ranked list ----------
  function renderRankList(){
    const titleEl = document.getElementById('ranklist-title');
    const el = document.getElementById('ranklist');
    let rows = [];
    const singleStation = (state.activeStations.size===1) ? [...state.activeStations][0] : null;

    if(state.view==='grade'){
      titleEl.textContent = '难易度分布 · 按单量';
      const keys = GRADE_KEYS.concat(['?']).filter(g=>GRADE_STATS[g].zips>0);
      const max = Math.max(...keys.map(g=>GRADE_STATS[g].volume), 1);
      rows = keys.map(g=>{
        const s = GRADE_STATS[g];
        const pph = s.pphN ? ` · PPH ${(s.pphSum/s.pphN).toFixed(1)}` : '';
        const pr  = s.priceVol ? ` · ${fmtPrice(s.priceSum/s.priceVol)}` : '';
        return {key:g, label:(g==='?'?'未评级':GRADE_LABELS[g]), val:s.volume,
                display:`${s.zips}个 · ${fmt(s.volume)}/d${pph}${pr}`,
                color:(g==='?'?NO_GRADE_FILL:GRADE_COLORS[g]),
                pct:s.volume/max*100, kind:'grade'};
      });
    } else if(singleStation && state.view!=='routes'){
      titleEl.textContent = `DSP 单量占比 · ${singleStation}`;
      rows = (STATION_DSP[singleStation]||[]).map(x=>({
        key:x.dsp, label:x.dsp, val:x.pct,
        display: fmt(x.vol)+'/d · '+x.pct.toFixed(1)+'%',
        color: DSP_COLORS[x.dsp]||'#888', pct:x.pct, kind:'stdsp', selected: dspOn(x.dsp)}));
    } else if(state.view==='station' || state.view==='volume'){
      titleEl.textContent = '站点 · 按单量';
      const max = Math.max(...STATION_KEYS.map(s=>STATIONS[s].total_volume));
      rows = STATION_KEYS.map(s=>({
        key:s, label:s, val:STATIONS[s].total_volume, display: fmt(STATIONS[s].total_volume)+'/d',
        color: STATION_COLORS[s], pct: STATIONS[s].total_volume/max*100, kind:'station'}));
    } else if(state.view==='dsp'){
      titleEl.textContent = 'DSP · 按单量';
      const max = Math.max(...DSP_KEYS.map(d=>DSP_SUMMARY[d].volume));
      rows = DSP_KEYS.slice().sort((a,b)=>DSP_SUMMARY[b].volume-DSP_SUMMARY[a].volume).map(d=>({
        key:d, label:`${d} <span style="color:var(--muted-2);font-weight:400">${DSP_SUMMARY[d].stations.length>1?DSP_SUMMARY[d].stations.length+'站':''}</span>`,
        val:DSP_SUMMARY[d].volume, display: fmt(DSP_SUMMARY[d].volume)+'/d',
        color: DSP_COLORS[d], pct: DSP_SUMMARY[d].volume/max*100, kind:'dsp'}));
    } else if(state.view==='routes'){
      titleEl.textContent = `线路 · ${state.focusStation}`;
      const info = STATIONS[state.focusStation];
      const rcolors = ROUTE_COLORS[state.focusStation] || {};
      const max = Math.max(...info.routes.map(r=>r.volume), 1);
      rows = info.routes.slice().sort((a,b)=>a.route.localeCompare(b.route,undefined,{numeric:true})).map(r=>({
        key:r.route, label:r.route, val:r.volume, display: fmt(r.volume)+'/d',
        color: rcolors[r.route]||'#888', pct: r.volume/max*100, kind:'route'}));
    } else if(state.view==='price'){
      titleEl.textContent = '站点 · 按加权均价';
      const max = Math.max(...STATION_KEYS.map(s=>STATIONS[s].avg_price));
      rows = STATION_KEYS.slice().sort((a,b)=>STATIONS[b].avg_price-STATIONS[a].avg_price).map(s=>({
        key:s, label:s, val:STATIONS[s].avg_price, display: fmtPrice(STATIONS[s].avg_price),
        color: STATION_COLORS[s], pct: STATIONS[s].avg_price/max*100, kind:'station'}));
    }

    el.innerHTML = rows.map(r=>`
      <div class="rank-row" data-kind="${r.kind}" data-key="${r.key}" style="${r.selected===false?'opacity:.4;':''}">
        <div class="rank-top"><span class="name"><span style="width:7px;height:7px;border-radius:50%;background:${r.color};display:inline-block;"></span>${r.label}</span><span class="val mono">${r.display}</span></div>
        <div class="rank-bar-bg"><div class="rank-bar-fill" style="width:${r.pct}%; background:${r.color};"></div></div>
      </div>`).join('');

    el.querySelectorAll('.rank-row').forEach(row=>{
      row.addEventListener('click', ()=>{
        const key = row.getAttribute('data-key');
        const kind = row.getAttribute('data-kind');
        if(kind==='grade') return;
        if(kind==='stdsp'){
          if(state.activeDsps.has(key)) state.activeDsps.delete(key); else state.activeDsps.add(key);
          refreshAll(); return;
        }
        if(kind==='station'){
          if(state.activeStations.has(key) && state.activeStations.size===1) state.activeStations = new Set();
          else { state.activeStations = new Set([key]); state.activeDsps = new Set(); }
          refreshAll(); highlightStation(key);
        }
        else if(kind==='route'){
          const pts = [];
          Object.values(ZIP_INDEX).forEach(z=>{
            if(z.station===state.focusStation && z.dominantRoute===key && z.lat && z.lon) pts.push([z.lat,z.lon]);
          });
          if(pts.length) map.flyToBounds(pts, {padding:[60,60], maxZoom:11, duration:0.6});
        }
        else {
          const pts = [];
          Object.values(ZIP_INDEX).forEach(z=>{ if(z.dominantDsp===key && z.lat && z.lon) pts.push([z.lat,z.lon]); });
          if(pts.length) map.flyToBounds(pts, {padding:[80,80], maxZoom:10, duration:0.6});
        }
      });
    });
  }

  // ---------- Chips ----------
  function renderChips(){
    const stEl = document.getElementById('station-chips');
    stEl.innerHTML = STATION_KEYS.map(s=>
      `<div class="chip ${stationOn(s)?'':'off'}" data-st="${s}"><span class="sw" style="background:${STATION_COLORS[s]}"></span>${s}</div>`).join('');
    stEl.querySelectorAll('.chip').forEach(c=>{
      c.addEventListener('click', ()=>{
        const s = c.getAttribute('data-st');
        if(state.activeStations.has(s) && state.activeStations.size===1) state.activeStations = new Set();
        else { state.activeStations = new Set([s]); state.activeDsps = new Set(); }
        refreshAll();
      });
    });

    const singleStation = state.activeStations.size===1 ? [...state.activeStations][0] : null;
    const stDsps = singleStation ? new Set((STATION_DSP[singleStation]||[]).map(x=>x.dsp)) : null;
    const dspEl = document.getElementById('dsp-chips');
    dspEl.innerHTML = DSP_KEYS.map(d=>{
      const inStation = !stDsps || stDsps.has(d);
      const on = inStation && dspOn(d);
      return `<div class="chip ${on?'':'off'}" data-dsp="${d}" ${!inStation?'data-disabled="1" style="opacity:.25;cursor:default;"':''}><span class="sw" style="background:${DSP_COLORS[d]}"></span>${d}</div>`;
    }).join('');
    dspEl.querySelectorAll('.chip').forEach(c=>{
      c.addEventListener('click', ()=>{
        if(c.getAttribute('data-disabled')) return;
        const d = c.getAttribute('data-dsp');
        if(state.activeDsps.has(d)) state.activeDsps.delete(d); else state.activeDsps.add(d);
        refreshAll();
      });
    });

    const stSel = state.activeStations.size===0 ? STATION_KEYS.length : state.activeStations.size;
    let dspSel;
    if(stDsps) dspSel = state.activeDsps.size===0 ? stDsps.size : [...state.activeDsps].filter(d=>stDsps.has(d)).length;
    else dspSel = state.activeDsps.size===0 ? DSP_KEYS.length : state.activeDsps.size;
    document.getElementById('stcount-lbl').textContent  = `(${stSel}/${STATION_KEYS.length})`;
    document.getElementById('dspcount-lbl').textContent = `(${dspSel}/${DSP_KEYS.length})`;

    const dimmed = state.view === 'routes';
    ['station-filter-section','dsp-filter-section'].forEach(id=>{
      const n = document.getElementById(id);
      n.style.opacity = dimmed ? 0.4 : 1;
      n.style.pointerEvents = dimmed ? 'none' : 'auto';
    });
  }

  // ---------- Top stats ----------
  function animateCount(el, target){
    let cur = 0; const inc = target/24;
    const t = setInterval(()=>{
      cur += inc;
      if(cur>=target){ cur = target; clearInterval(t); }
      el.textContent = fmt(cur);
    }, 16);
  }

  function renderTopStats(){
    let totalVol = 0, zipCount = 0;
    STATION_KEYS.forEach(s=>{
      if(!stationOn(s)) return;
      STATIONS[s].zips.forEach(z=>{
        if(!dspOn(Object.entries(z.dsps).sort((a,b)=>b[1]-a[1])[0]?.[0])) return;
        totalVol += z.volume; zipCount++;
      });
    });
    document.getElementById('stat-volume').textContent = fmt(totalVol);
    document.getElementById('stat-zips').textContent = zipCount;
    document.getElementById('stat-stations').textContent =
      state.activeStations.size===0 ? STATION_KEYS.length : state.activeStations.size;
  }

  function refreshAll(){
    buildZipLayer(); buildRouteLabels(); buildMarkers();
    renderLegend(); renderRoutePanel(); renderRouteFocusChips();
    renderRankList(); renderChips(); renderTopStats();
    const names = {station:'站点 Stations', dsp:'DSP', price:'价格 Price',
                   volume:'单量 Volume', grade:'难易度 Difficulty'};
    const viewLabel = state.view==='routes' ? `线路 · ${state.focusStation}` : names[state.view];
    document.getElementById('viewlabel').innerHTML = `当前视图: <b>${viewLabel}</b>`;
    if(state.view==='routes'){
      const zoomHint = map.getZoom() < 8 ? ' · 放大后显示线路编号' : '';
      document.getElementById('filterlabel').textContent =
        `· 显示 ${STATIONS[state.focusStation].routes.length} 条线路,其他站点已隐藏${zoomHint}`;
    } else if(state.view==='grade'){
      document.getElementById('filterlabel').textContent =
        `· ${GRADED_ZIPS}/${Object.keys(ZIP_INDEX).length} 个邮编有难易度评级(仅 LAS01/TUC01)`;
    } else {
      const hiddenSt  = state.activeStations.size===0 ? 0 : STATION_KEYS.length - state.activeStations.size;
      const hiddenDsp = state.activeDsps.size===0     ? 0 : DSP_KEYS.length - state.activeDsps.size;
      document.getElementById('filterlabel').textContent =
        (hiddenSt||hiddenDsp) ? `· 已隐藏 ${hiddenSt} 个站点 / ${hiddenDsp} 家 DSP` : '';
    }
  }

  // ---------- View tabs ----------
  document.getElementById('viewtabs').addEventListener('click', (e)=>{
    const tab = e.target.closest('.viewtab');
    if(!tab) return;
    document.querySelectorAll('.viewtab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    state.view = tab.getAttribute('data-view');
    state.focusRoute = null;
    refreshAll();
    if(state.view==='routes') highlightStation(state.focusStation);
  });

  // ---------- Bulk actions ----------
  document.addEventListener('click', (e)=>{
    const act = e.target.getAttribute && e.target.getAttribute('data-act');
    if(!act) return;
    if(act==='all-st'  || act==='none-st')  state.activeStations = new Set();
    if(act==='all-dsp' || act==='none-dsp') state.activeDsps = new Set();
    refreshAll();
  });

  // ---------- Station quick-jump (the region is too spread out to pan) ----------
  const jump = document.getElementById('station-jump');
  jump.innerHTML = `<option value="">跳转到站点…</option>` +
    STATION_KEYS.map(s=>`<option value="${s}">${s} · ${fmt(STATIONS[s].total_volume)}/d · ${STATIONS[s].zip_count} 邮编</option>`).join('');
  jump.addEventListener('change', ()=>{
    if(!jump.value) return;
    highlightStation(jump.value);
    jump.value = '';
  });

  // ---------- Search ----------
  document.getElementById('zipsearch').addEventListener('keydown', (e)=>{
    if(e.key !== 'Enter') return;
    const rec = ZIP_INDEX[e.target.value.trim()];
    if(rec && rec.lat && rec.lon){
      map.flyTo([rec.lat, rec.lon], 11, {duration:0.7});
      setTimeout(()=>{
        L.popup({maxWidth:290}).setLatLng([rec.lat,rec.lon]).setContent(zipPopupHtml(rec)).openOn(map);
      }, 750);
    } else {
      e.target.style.borderColor = '#FF6B6B';
      setTimeout(()=>{ e.target.parentElement.style.borderColor=''; }, 900);
    }
  });

  // ---------- Reset ----------
  document.getElementById('resetbtn').addEventListener('click', ()=>{
    state.activeStations = new Set();
    state.activeDsps = new Set();
    map.flyToBounds(REGION_BOUNDS, {padding:[40,40], duration:0.6});
    highlightLayer.clearLayers();
    refreshAll();
  });

  // ---------- Data note ----------
  (function(){
    const noGeom = Object.values(ZIP_INDEX).filter(z=>!z.has_geom).map(z=>z.zip);
    document.getElementById('dataflag-text').innerHTML =
      `邮编 <b>${noGeom.join(', ')}</b> 无 ZCTA 行政边界(PO Box 专用邮编),地图上不绘制色块,`
      + `位置取所属站点服务区的单量加权中心。难易度评级仅 LAS01、TUC01 两站有数据,`
      + `覆盖 <b>${GRADED_ZIPS}/${Object.keys(ZIP_INDEX).length}</b> 个邮编。`;
  })();

  // ---------- Deep link: #view=grade&station=PHX01&zip=85043 ----------
  const VIEWS = ['station','dsp','routes','price','volume','grade'];
  function applyHash(){
    const h = new URLSearchParams(location.hash.replace(/^#/,''));
    const v = h.get('view');
    if(v && VIEWS.includes(v)){
      state.view = v;
      document.querySelectorAll('.viewtab').forEach(t=>
        t.classList.toggle('active', t.getAttribute('data-view')===v));
    }
    const st = h.get('station');
    if(st && STATIONS[st]){
      state.focusStation = st;
      if(state.view !== 'routes') state.activeStations = new Set([st]);
    }
    refreshAll();
    const z = h.get('zip');
    if(z && ZIP_INDEX[z]){
      const rec = ZIP_INDEX[z];
      map.setView([rec.lat, rec.lon], 11);
      L.popup({maxWidth:290}).setLatLng([rec.lat,rec.lon]).setContent(zipPopupHtml(rec)).openOn(map);
    } else if(st && STATIONS[st]){
      highlightStation(st);
    } else if(state.view==='routes'){
      highlightStation(state.focusStation);
    }
  }
  window.addEventListener('hashchange', applyHash);

  // ---------- Init ----------
  refreshAll();
  if(location.hash) applyHash();
  animateCount(document.getElementById('stat-volume'),
               STATION_KEYS.reduce((a,s)=>a+STATIONS[s].total_volume,0));
})();
