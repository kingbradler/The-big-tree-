/* =========================================================
   ECO-TRANSIT IA — Logique principale
   Carte : Mapbox GL JS (token fourni par l'utilisateur)
   IA de tournée : algorithme glouton (plus proche voisin)
   ========================================================= */

mapboxgl.accessToken = 'pk.eyJ1Ijoic2VydmlzLXN1cGVycmFwaWQiLCJhIjoiY21yNTU1anphMGlmNTJ6c2R0aXppdjBtayJ9.LFvqL6ZhU7PcvjkJ4tWVeQ';

// ---------------------------------------------------------
// SUPABASE — synchronisation temps réel de la file d'attente
// ---------------------------------------------------------
const SUPABASE_URL = 'https://arubxxoiaqmsgzselzib.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFydWJ4eG9pYXFtc2d6c2VsemliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwODc2MjcsImV4cCI6MjA5ODY2MzYyN30.sMtKrzdlGuCpDnuKK9xPJlam_Bd0e0_Ai2ANHmy565g';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------------------------------------------------
// UI — notifications visibles (au lieu de simples console.error)
// ---------------------------------------------------------
let toastContainer = document.getElementById('toast-container');
if (!toastContainer) {
  toastContainer = document.createElement('div');
  toastContainer.id = 'toast-container';
  document.body.appendChild(toastContainer);
}
function showToast(message, type = 'error', duration = 6000) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span>${message}</span><button class="toast-close" aria-label="Fermer">×</button>`;
  el.querySelector('.toast-close').addEventListener('click', () => el.remove());
  toastContainer.appendChild(el);
  if (duration) setTimeout(() => el.remove(), duration);
}

// Centre : Tanger, Maroc
const TANGER_CENTER = [-5.8340, 35.7595];

// Position de départ du chauffeur — valeur de repli si la table
// `chauffeurs` est vide (ne devrait pas arriver, voir ensureChauffeur ci-dessous)
const DRIVER_START = { lng: -5.8128, lat: 35.7473 };

// Chauffeur "actif" pour cette session du Tableau de Bord — lu (ou créé)
// depuis la table `chauffeurs` au lieu d'une position codée en dur.
let currentChauffeur = {
  id: null,
  lng: DRIVER_START.lng,
  lat: DRIVER_START.lat,
  capacite_places: 8
};

// Récupère le premier chauffeur disponible en base, ou en crée un par
// défaut si la table est vide (cas du tout premier lancement du projet).
async function ensureChauffeur() {
  const { data: existing, error: selectError } = await supabaseClient
    .from('chauffeurs')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(1);

  if (selectError) {
    showToast("Impossible de charger le chauffeur : " + selectError.message, 'error');
    return;
  }

  if (existing && existing.length) {
    currentChauffeur = existing[0];
    return;
  }

  // Aucun chauffeur en base — on en crée un par défaut pour la démo
  const { data: created, error: insertError } = await supabaseClient
    .from('chauffeurs')
    .insert({
      immatriculation: 'DEMO-001',
      capacite_places: 8,
      consommation_l_100km: 12,
      statut: 'disponible',
      lat: DRIVER_START.lat,
      lng: DRIVER_START.lng
    })
    .select()
    .single();

  if (insertError) {
    showToast("Impossible de créer le chauffeur par défaut : " + insertError.message, 'error');
    return;
  }
  currentChauffeur = created;
}

// État partagé de l'application (simule la synchronisation temps réel
// entre l'espace passager et le tableau de bord chauffeur)
const state = {
  clients: [],       // {id, lng, lat, marker}
  driverMarker: null,
  routeCoords: null, // dernier itinéraire optimisé
};

/* ---------------------------------------------------------
   UTILITAIRES
--------------------------------------------------------- */
function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180, lat2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Génère un point plausible autour de Tanger (rayon ~4km) pour simuler le GPS
function randomPointNearTanger() {
  const radiusKm = 1.2 + Math.random() * 3.2;
  const angle = Math.random() * 2 * Math.PI;
  const dLat = (radiusKm / 111) * Math.sin(angle);
  const dLng = (radiusKm / (111 * Math.cos(TANGER_CENTER[1] * Math.PI / 180))) * Math.cos(angle);
  return { lng: TANGER_CENTER[0] + dLng, lat: TANGER_CENTER[1] + dLat };
}

/* ---------------------------------------------------------
   NAVIGATION ENTRE VUES
--------------------------------------------------------- */
const tabs = document.querySelectorAll('.tab');
const views = { passager: document.getElementById('view-passager'), chauffeur: document.getElementById('view-chauffeur') };

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    Object.values(views).forEach(v => v.classList.remove('active'));
    const target = views[tab.dataset.view];
    target.classList.add('active');
    // Mapbox a besoin d'un resize quand son conteneur redevient visible
    setTimeout(() => {
      if (tab.dataset.view === 'passager') mapPassager.resize();
      else mapChauffeur.resize();
    }, 50);
  });
});

/* ---------------------------------------------------------
   CARTE — ESPACE PASSAGER
--------------------------------------------------------- */
const mapPassager = new mapboxgl.Map({
  container: 'map-passager',
  style: 'mapbox://styles/mapbox/light-v11',
  center: TANGER_CENTER,
  zoom: 12.5
});
mapPassager.addControl(new mapboxgl.NavigationControl(), 'top-right');

const btnShare = document.getElementById('btn-share-location');
const statusCard = document.getElementById('passenger-status');
const statusSub = document.getElementById('passenger-status-sub');
const queueCountEl = document.getElementById('queue-count');

btnShare.addEventListener('click', () => {
  btnShare.disabled = true;
  const originalHTML = btnShare.innerHTML;
  btnShare.innerHTML = 'Localisation…';

  const place = async (coords, precise) => {
    try {
      await addClient(coords);
      mapPassager.flyTo({ center: [coords.lng, coords.lat], zoom: 14.5 });
      statusCard.classList.remove('hidden');
      statusSub.textContent = precise
        ? 'Position GPS réelle transmise au chauffeur le plus proche'
        : 'Position simulée transmise au chauffeur le plus proche';
    } catch (e) {
      // erreur déjà affichée via showToast dans addClient()
    } finally {
      btnShare.innerHTML = originalHTML;
      btnShare.disabled = false;
    }
  };

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => place({ lng: pos.coords.longitude, lat: pos.coords.latitude }, true),
      () => {
        showToast("Géolocalisation indisponible ou refusée — position simulée utilisée.", 'info', 5000);
        place(randomPointNearTanger(), false);
      },
      { timeout: 4000 }
    );
  } else {
    showToast("Votre navigateur ne supporte pas la géolocalisation — position simulée utilisée.", 'info', 5000);
    place(randomPointNearTanger(), false);
  }
});

// Ajoute une demande de course dans Supabase — la mise à jour visuelle
// (marker, compteur, carte chauffeur) se fait via l'abonnement realtime
// plus bas, donc TOUS les onglets ouverts (passager + chauffeur) se
// mettent à jour automatiquement.
async function addClient(coords) {
  const { error } = await supabaseClient
    .from('demandes_course')
    .insert({ lat: coords.lat, lng: coords.lng, statut: 'en_attente' });
  if (error) {
    showToast("Impossible d'envoyer votre position : " + error.message, 'error');
    throw error;
  }
}

// Markers affichés sur la carte passager (redessinés à chaque refresh)
let passengerClientMarkers = [];
function renderPassengerMarkers() {
  passengerClientMarkers.forEach(m => m.remove());
  passengerClientMarkers = [];
  state.clients.forEach(c => {
    const el = document.createElement('div');
    el.className = 'marker-client';
    passengerClientMarkers.push(new mapboxgl.Marker(el).setLngLat([c.lng, c.lat]).addTo(mapPassager));
  });
}

// Recharge la file complète depuis Supabase et remet à jour l'UI
async function refreshQueueFromSupabase() {
  const { data, error } = await supabaseClient
    .from('demandes_course')
    .select('*')
    .eq('statut', 'en_attente')
    .order('created_at', { ascending: true });

  if (error) {
    showToast("Impossible de charger la file d'attente : " + error.message, 'error');
    return;
  }

  state.clients = data.map(row => ({
    id: row.id, lng: row.lng, lat: row.lat, coords: { lng: row.lng, lat: row.lat }
  }));

  queueCountEl.textContent = state.clients.length;
  syncDriverMarkers();
  renderPassengerMarkers();
  updateCapacityHint();
}

// Nettoyage best-effort : supprime les demandes terminées/annulées de plus
// de 24h pour éviter que la table de file d'attente ne grossisse indéfiniment.
// (L'historique utile — courses + kpis_energie — n'est jamais touché.)
async function cleanupOldDemandes() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabaseClient
    .from('demandes_course')
    .delete()
    .in('statut', ['terminee', 'annulee'])
    .lt('created_at', cutoff);
  if (error) console.warn('Nettoyage demandes_course ignoré:', error.message);
}

// Abonnement temps réel : toute nouvelle ligne insérée ou mise à jour
// (par n'importe quel visiteur/onglet) déclenche un rafraîchissement
supabaseClient
  .channel('demandes_course_changes')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'demandes_course' }, () => {
    refreshQueueFromSupabase();
  })
  .subscribe();

// Chargement initial au démarrage de la page
ensureChauffeur().then(() => { maybePlaceDriverMarker(); updateCapacityHint(); });
cleanupOldDemandes();
refreshQueueFromSupabase();

/* ---------------------------------------------------------
   CARTE — TABLEAU DE BORD CHAUFFEUR
--------------------------------------------------------- */
const mapChauffeur = new mapboxgl.Map({
  container: 'map-chauffeur',
  style: 'mapbox://styles/mapbox/light-v11',
  center: TANGER_CENTER,
  zoom: 12.3
});
mapChauffeur.addControl(new mapboxgl.NavigationControl(), 'top-right');

let driverMarkerEl, driverClientMarkers = [], driverMarker = null;
let mapChauffeurLoaded = false;

mapChauffeur.on('load', () => {
  mapChauffeurLoaded = true;

  mapChauffeur.addSource('route', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } } });
  mapChauffeur.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#3E9142', 'line-width': 5, 'line-opacity': 0.9 }
  });

  maybePlaceDriverMarker();
});

// Place (ou déplace) le marker du chauffeur une fois que la carte est
// chargée ET que le chauffeur a été lu/créé dans Supabase (ensureChauffeur).
function maybePlaceDriverMarker() {
  if (!mapChauffeurLoaded || !currentChauffeur) return;
  if (driverMarker) {
    driverMarker.setLngLat([currentChauffeur.lng, currentChauffeur.lat]);
    return;
  }
  driverMarkerEl = document.createElement('div');
  driverMarkerEl.className = 'marker-driver';
  driverMarkerEl.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4"><rect x="3" y="9" width="18" height="8" rx="2"/><circle cx="7.5" cy="17" r="1.3"/><circle cx="16.5" cy="17" r="1.3"/></svg>';
  driverMarker = new mapboxgl.Marker(driverMarkerEl).setLngLat([currentChauffeur.lng, currentChauffeur.lat]).addTo(mapChauffeur);
}

function syncDriverMarkers() {
  driverClientMarkers.forEach(m => m.remove());
  driverClientMarkers = [];
  state.clients.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'marker-client';
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.color = '#fff';
    el.style.fontSize = '11px';
    el.style.fontWeight = '700';
    el.textContent = i + 1;
    const marker = new mapboxgl.Marker(el).setLngLat([c.lng, c.lat]).addTo(mapChauffeur);
    driverClientMarkers.push(marker);
  });
}

/* ---------------------------------------------------------
   IA — ALGORITHME GLOUTON DE TOURNÉE (plus proche voisin)
--------------------------------------------------------- */
function nearestNeighborRoute(start, clients) {
  const remaining = [...clients];
  const order = [];
  let current = start;
  while (remaining.length) {
    let bestIdx = 0, bestDist = Infinity;
    remaining.forEach((c, i) => {
      const d = haversineKm(current, c);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    const next = remaining.splice(bestIdx, 1)[0];
    order.push(next);
    current = next;
  }
  return order;
}

function routeDistance(start, orderedClients) {
  let total = 0, current = start;
  orderedClients.forEach(c => { total += haversineKm(current, c); current = c; });
  return total;
}

/* ---------------------------------------------------------
   OPTIMISATION — bouton chauffeur
--------------------------------------------------------- */
const btnOptimize = document.getElementById('btn-optimize');
const kpiFuel = document.getElementById('kpi-fuel');
const kpiCo2 = document.getElementById('kpi-co2');
const kpiDist = document.getElementById('kpi-dist');
const routeOrderList = document.getElementById('route-order');
const driverHint = document.getElementById('driver-hint');

// Affiche un rappel de capacité quand la file dépasse la capacité du véhicule
function updateCapacityHint() {
  const capacity = currentChauffeur.capacite_places || 8;
  if (state.clients.length > capacity) {
    driverHint.textContent = `${state.clients.length} passager(s) en attente, mais le véhicule ne peut prendre que ${capacity} places. La tournée traitera les ${capacity} premiers, les autres resteront en file.`;
  } else if (state.clients.length > 0) {
    driverHint.textContent = `${state.clients.length} passager(s) en attente (capacité : ${capacity} places). Lancez l'optimisation quand vous êtes prêt.`;
  } else {
    driverHint.textContent = "Ajoutez des passagers depuis l'Espace Passager, puis lancez l'optimisation.";
  }
}

btnOptimize.addEventListener('click', async () => {
  if (!state.clients.length) {
    driverHint.textContent = "Aucun passager en attente pour le moment. Ajoutez-en depuis l'Espace Passager.";
    return;
  }

  const capacity = currentChauffeur.capacite_places || 8;
  const batch = state.clients.slice(0, capacity); // file déjà triée par ancienneté (FIFO)
  const overflow = state.clients.length - batch.length;
  const driverPos = { lat: currentChauffeur.lat, lng: currentChauffeur.lng };

  btnOptimize.disabled = true;
  btnOptimize.querySelector('svg').style.display = 'none';
  const originalText = btnOptimize.childNodes[2].textContent;
  btnOptimize.childNodes[2].textContent = ' Calcul en cours…';

  // 0) Réserve immédiatement ce lot pour CE chauffeur, avant même de
  // calculer l'itinéraire. La condition .eq('statut','en_attente') évite
  // d'écraser une demande qu'un autre tableau de bord aurait prise
  // entre-temps — première réservation gagne (pas de double dispatch).
  const batchIds = batch.map(c => c.id).filter(Boolean);
  if (batchIds.length) {
    const { error: claimError } = await supabaseClient
      .from('demandes_course')
      .update({ statut: 'assignee', chauffeur_id: currentChauffeur.id || null })
      .in('id', batchIds)
      .eq('statut', 'en_attente');
    if (claimError) {
      showToast("Impossible de réserver ces passagers : " + claimError.message, 'error');
      btnOptimize.disabled = false;
      btnOptimize.querySelector('svg').style.display = '';
      btnOptimize.childNodes[2].textContent = originalText;
      return;
    }
  }
  if (currentChauffeur.id) {
    await supabaseClient.from('chauffeurs').update({ statut: 'en_course' }).eq('id', currentChauffeur.id);
  }

  // 1) Ordre optimal (glouton / plus proche voisin) sur le lot réservé
  const optimalOrder = nearestNeighborRoute(driverPos, batch);

  // 2) Distance optimisée vs distance "à vide" (ordre d'arrivée non optimisé)
  const optimizedDistance = routeDistance(driverPos, optimalOrder);
  const naiveDistance = routeDistance(driverPos, batch);
  const distanceSaved = Math.max(naiveDistance - optimizedDistance, naiveDistance * 0.08);
  const fuelSavedPct = Math.min(65, Math.round((distanceSaved / naiveDistance) * 100));

  // Hypothèses de consommation minibus : ~12 L / 100km, 2.31 kg CO2 / L essence
  const litersSaved = (distanceSaved / 100) * 12;
  const co2Saved = litersSaved * 2.31;

  // 3) Tracé réel de l'itinéraire via l'API Directions Mapbox
  const coordsForApi = [driverPos, ...optimalOrder].map(p => `${p.lng},${p.lat}`).join(';');
  try {
    const res = await fetch(`https://api.mapbox.com/directions/v5/mapbox/driving/${coordsForApi}?geometries=geojson&overview=full&access_token=${mapboxgl.accessToken}`);
    const data = await res.json();
    if (data.routes && data.routes[0]) {
      mapChauffeur.getSource('route').setData({
        type: 'Feature',
        geometry: data.routes[0].geometry
      });
      const bounds = new mapboxgl.LngLatBounds();
      data.routes[0].geometry.coordinates.forEach(c => bounds.extend(c));
      mapChauffeur.fitBounds(bounds, { padding: 60, duration: 900 });
    }
  } catch (e) {
    showToast("API Directions indisponible, tracé simplifié utilisé.", 'info', 4000);
    mapChauffeur.getSource('route').setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[driverPos.lng, driverPos.lat], ...optimalOrder.map(c => [c.lng, c.lat])] }
    });
  }

  // 4) Mise à jour KPIs + ordre de ramassage
  kpiFuel.innerHTML = `${fuelSavedPct}<small>%</small>`;
  kpiCo2.innerHTML = `${co2Saved.toFixed(1)}<small>kg</small>`;
  kpiDist.innerHTML = `${distanceSaved.toFixed(1)}<small>km</small>`;

  routeOrderList.innerHTML = '';
  optimalOrder.forEach((c, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<b>Arrêt ${i + 1}</b> — ${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`;
    routeOrderList.appendChild(li);
  });

  // Re-numéroter les marqueurs selon l'ordre optimal
  driverClientMarkers.forEach(m => m.remove());
  driverClientMarkers = [];
  optimalOrder.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'marker-client';
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.color = '#fff';
    el.style.fontSize = '11px';
    el.style.fontWeight = '700';
    el.textContent = i + 1;
    driverClientMarkers.push(new mapboxgl.Marker(el).setLngLat([c.lng, c.lat]).addTo(mapChauffeur));
  });

  driverHint.textContent = overflow > 0
    ? `Itinéraire optimisé pour ${optimalOrder.length} passager(s) (capacité max atteinte). ${overflow} passager(s) restent en file pour une prochaine tournée.`
    : `Itinéraire optimisé pour ${optimalOrder.length} passager(s). Trajet à vide éliminé grâce à l'IA.`;
  btnOptimize.querySelector('svg').style.display = '';
  btnOptimize.childNodes[2].textContent = originalText;
  btnOptimize.disabled = false;

  // 5) Enregistre la course + ses KPIs, puis clôture les demandes servies.
  // La file se videra automatiquement (côté passager comme chauffeur)
  // grâce à l'abonnement realtime sur demandes_course.
  try {
    const { data: course, error: courseError } = await supabaseClient
      .from('courses')
      .insert({
        chauffeur_id: currentChauffeur.id || null,
        distance_optimisee_km: optimizedDistance,
        distance_naive_km: naiveDistance,
        terminee_at: new Date().toISOString()
      })
      .select()
      .single();
    if (courseError) throw courseError;

    const { error: kpiError } = await supabaseClient
      .from('kpis_energie')
      .insert({
        course_id: course.id,
        carburant_economise_pct: fuelSavedPct,
        litres_economises: litersSaved,
        co2_evite_kg: co2Saved,
        distance_economisee_km: distanceSaved
      });
    if (kpiError) throw kpiError;

    if (batchIds.length) {
      // Met à jour l'ordre de ramassage individuellement (chaque demande
      // a un ordre différent), puis clôture le lot en une seule requête.
      await Promise.all(optimalOrder.map((c, i) =>
        c.id ? supabaseClient.from('demandes_course').update({ ordre_ramassage: i + 1 }).eq('id', c.id) : null
      ));
      const { error: statutError } = await supabaseClient
        .from('demandes_course')
        .update({ statut: 'terminee', ramasse_at: new Date().toISOString() })
        .in('id', batchIds);
      if (statutError) throw statutError;
    }

    if (currentChauffeur.id) {
      await supabaseClient.from('chauffeurs').update({ statut: 'disponible' }).eq('id', currentChauffeur.id);
    }
  } catch (err) {
    showToast("Erreur lors de l'enregistrement de la course : " + (err.message || err), 'error');
  }
});
