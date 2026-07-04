/* =========================================================
   ECO-TRANSIT IA — Logique principale
   Carte : Mapbox GL JS (token fourni par l'utilisateur)
   IA de tournée : algorithme glouton (plus proche voisin)
   ========================================================= */

// ---------------------------------------------------------
// MOBILE — hauteur d'écran réelle (le 100vh classique bouge
// quand la barre d'adresse Android/Safari apparaît ou se
// cache ; on recalcule --vh en JS pour un layout stable).
// ---------------------------------------------------------
function setRealViewportHeight() {
  document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
}
setRealViewportHeight();
window.addEventListener('resize', setRealViewportHeight);
window.addEventListener('orientationchange', () => {
  // léger délai : sur iOS innerHeight n'est pas encore à jour à l'événement lui-même
  setTimeout(() => {
    setRealViewportHeight();
    try { mapPassager?.resize(); mapChauffeur?.resize(); mapAdmin?.resize(); } catch (e) {}
  }, 250);
});

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

// Récupère le chauffeur lié au compte connecté (user_id), ou en crée un
// par défaut si le profil chauffeur n'a pas encore été créé (filet de
// sécurité au cas où l'insertion faite pendant l'inscription aurait échoué).
// Nécessite une colonne `user_id` (uuid, référence auth.users) sur la table
// `chauffeurs` — voir instructions de mise en place.
async function ensureChauffeur(userId) {
  if (!userId) return;

  const { data: existing, error: selectError } = await supabaseClient
    .from('chauffeurs')
    .select('*')
    .eq('user_id', userId)
    .limit(1);

  if (selectError) {
    showToast("Impossible de charger le profil chauffeur : " + selectError.message, 'error');
    return;
  }

  if (existing && existing.length) {
    currentChauffeur = existing[0];
    maybePlaceDriverMarker();
    updateCapacityHint();
    return;
  }

  // Aucun profil chauffeur trouvé — on en crée un par défaut
  const { data: created, error: insertError } = await supabaseClient
    .from('chauffeurs')
    .insert({
      user_id: userId,
      immatriculation: 'À COMPLÉTER',
      capacite_places: 8,
      consommation_l_100km: 12,
      statut: 'disponible',
      lat: DRIVER_START.lat,
      lng: DRIVER_START.lng
    })
    .select()
    .single();

  if (insertError) {
    showToast("Impossible de créer le profil chauffeur : " + insertError.message, 'error');
    return;
  }
  currentChauffeur = created;
  maybePlaceDriverMarker();
  updateCapacityHint();
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
const views = {
  passager: document.getElementById('view-passager'),
  chauffeur: document.getElementById('view-chauffeur'),
  admin: document.getElementById('view-admin')
};

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
      else if (tab.dataset.view === 'chauffeur') mapChauffeur.resize();
      else if (tab.dataset.view === 'admin') mapAdmin.resize();
    }, 50);
  });
});

/* ---------------------------------------------------------
   PAGE MARKETING — vitrine publique avant connexion
--------------------------------------------------------- */
const viewMarketing = document.getElementById('view-marketing');
const viewHomeEl = document.getElementById('view-home');

function showMarketing() {
  viewHomeEl.classList.remove('active');
  viewMarketing.classList.add('active');
  document.body.classList.add('on-marketing');
  navCta.classList.remove('hidden');
}

function showAuth(mode) {
  viewMarketing.classList.remove('active');
  viewHomeEl.classList.add('active');
  document.body.classList.remove('on-marketing');
  navCta.classList.add('hidden');
  setAuthMode(mode);
}

document.getElementById('nav-login-btn').addEventListener('click', () => showAuth('login'));
document.getElementById('nav-signup-btn').addEventListener('click', () => showAuth('signup'));
document.getElementById('hero-login-btn').addEventListener('click', () => showAuth('login'));
document.getElementById('hero-signup-btn').addEventListener('click', () => showAuth('signup'));
document.getElementById('back-to-marketing').addEventListener('click', showMarketing);

// Etat initial : page marketing visible, scroll autorisé
document.body.classList.add('on-marketing');

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
    if (document.getElementById('view-admin').classList.contains('active')) loadAdminDashboard();
  })
  .subscribe();

// Idem côté chauffeurs : l'admin voit un chauffeur basculer disponible/en
// course/suspendu sans avoir à rafraîchir la page.
supabaseClient
  .channel('chauffeurs_changes')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'chauffeurs' }, () => {
    if (document.getElementById('view-admin').classList.contains('active')) loadAdminDashboard();
  })
  .subscribe();

// Chargement initial au démarrage de la page — la file d'attente est
// publique et peut se charger tout de suite ; le profil chauffeur, lui,
// n'est chargé qu'après connexion (voir onLoginSuccess plus bas).
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
   IA PRÉDICTIVE — réseau de neurones (TensorFlow.js)
   ---------------------------------------------------------
   Objectif : prédire le meilleur ordre de ramassage, en
   remplacement optionnel de l'algorithme glouton ci-dessus.

   Honnêteté sur la méthode (important pour la démo) :
   - Aucune donnée réelle n'est utilisée pour l'instant.
   - Le modèle est entraîné, au chargement de la page, sur des
     milliers de trajets SIMULÉS (positions aléatoires), dont
     le vrai ordre optimal est calculé par force brute (rapide
     car on limite à 6 passagers max, 6! = 720 permutations).
   - Le réseau apprend donc à reproduire ce calcul par force
     brute — c'est un véritable apprentissage supervisé, mais
     calibré sur des données synthétiques, pas sur votre trafic
     réel. Pour une vraie mise en production, il faudrait
     réentraîner avec l'historique de `demandes_course`.
--------------------------------------------------------- */
const IA_MAX_PASSAGERS = 6;
const IA_MIN_PASSAGERS = 2;

let iaModel = null;
let iaReady = false;
const iaStatusEl = document.getElementById('ia-status');
const iaToggleEl = document.getElementById('toggle-ia');

function setIaStatus(text, ready) {
  if (!iaStatusEl) return;
  iaStatusEl.textContent = text;
  iaStatusEl.classList.toggle('ia-ready', !!ready);
}

// Distance euclidienne simple (les données d'entraînement sont en km relatifs, pas en lat/lng)
function euclid(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

// Calcule l'ordre de visite optimal par force brute (K ≤ 6, donc ≤ 720 permutations)
function bruteForceOptimalOrder(pointsRel) {
  const indices = pointsRel.map((_, i) => i);
  let best = null, bestDist = Infinity;

  function permute(arr, acc) {
    if (!arr.length) {
      let d = 0, current = [0, 0];
      acc.forEach(i => { d += euclid(current, pointsRel[i]); current = pointsRel[i]; });
      if (d < bestDist) { bestDist = d; best = [...acc]; }
      return;
    }
    for (let i = 0; i < arr.length; i++) {
      const rest = arr.slice(0, i).concat(arr.slice(i + 1));
      permute(rest, [...acc, arr[i]]);
    }
  }
  permute(indices, []);
  return best; // ex: [2,0,1] = ordre des index à visiter
}

// Génère un jeu d'entraînement synthétique
function generateIaTrainingSet(numExamples) {
  const X = [], Y = [];
  for (let n = 0; n < numExamples; n++) {
    const K = IA_MIN_PASSAGERS + Math.floor(Math.random() * (IA_MAX_PASSAGERS - IA_MIN_PASSAGERS + 1));
    const points = Array.from({ length: K }, () => [
      (Math.random() * 2 - 1) * 6, // dx en km, chauffeur simulé en [0,0]
      (Math.random() * 2 - 1) * 6  // dy en km
    ]);
    const order = bruteForceOptimalOrder(points);
    const rank = new Array(K);
    order.forEach((idx, pos) => { rank[idx] = pos / Math.max(K - 1, 1); });

    points.forEach((p, i) => {
      const dist = euclid([0, 0], p);
      X.push([p[0], p[1], dist, K / IA_MAX_PASSAGERS]);
      Y.push(rank[i]);
    });
  }
  return { X, Y };
}

function buildIaModel() {
  const model = tf.sequential();
  model.add(tf.layers.dense({ inputShape: [4], units: 16, activation: 'relu' }));
  model.add(tf.layers.dense({ units: 8, activation: 'relu' }));
  model.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));
  model.compile({ optimizer: tf.train.adam(0.01), loss: 'meanSquaredError' });
  return model;
}

async function trainIaModel() {
  try {
    setIaStatus("Entraînement de l'IA (données simulées)…", false);
    const { X, Y } = generateIaTrainingSet(1500);
    const xs = tf.tensor2d(X);
    const ys = tf.tensor2d(Y, [Y.length, 1]);

    const model = buildIaModel();
    await model.fit(xs, ys, {
      epochs: 40,
      batchSize: 32,
      shuffle: true,
      callbacks: {
        onEpochEnd: (epoch) => {
          if (epoch % 10 === 0) setIaStatus(`Entraînement… (${epoch}/40)`, false);
        }
      }
    });
    xs.dispose(); ys.dispose();

    iaModel = model;
    iaReady = true;
    setIaStatus('IA prête (entraînée sur données simulées)', true);
  } catch (e) {
    setIaStatus("IA indisponible — algorithme utilisé", false);
    showToast("Entraînement de l'IA impossible, l'algorithme classique reste utilisé.", 'info', 5000);
  }
}

// Convertit lat/lng en offset approximatif en km par rapport au chauffeur
// (mêmes ordres de grandeur que les données d'entraînement synthétiques)
function relKmFromDriver(driver, point) {
  const dLat = (point.lat - driver.lat) * 110.574;
  const dLng = (point.lng - driver.lng) * 111.320 * Math.cos(driver.lat * Math.PI / 180);
  return [dLng, dLat];
}

// Prédit l'ordre de ramassage via le réseau de neurones. Retourne null si
// l'IA n'est pas prête ou si le nombre de passagers dépasse ce qu'elle a
// appris à traiter (repli automatique sur l'algorithme classique dans ce cas).
function predictOrderIA(driverPos, clients) {
  if (!iaReady || !iaModel) return null;
  if (clients.length < IA_MIN_PASSAGERS || clients.length > IA_MAX_PASSAGERS) return null;

  const K = clients.length;
  const features = clients.map(c => {
    const [dx, dy] = relKmFromDriver(driverPos, c);
    const dist = Math.hypot(dx, dy);
    return [dx, dy, dist, K / IA_MAX_PASSAGERS];
  });

  const input = tf.tensor2d(features);
  const scores = iaModel.predict(input).dataSync();
  input.dispose();

  return clients
    .map((c, i) => ({ c, score: scores[i] }))
    .sort((a, b) => a.score - b.score)
    .map(o => o.c);
}

// Entraînement lancé en tâche de fond dès le chargement (n'empêche pas le
// reste de l'app de fonctionner pendant les ~1-2 secondes que ça prend)
if (typeof tf !== 'undefined') {
  trainIaModel();
} else {
  setIaStatus('IA indisponible (librairie non chargée)', false);
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

  // 1) Ordre de ramassage : IA prédictive si activée et applicable, sinon
  // repli sur l'algorithme glouton (plus proche voisin) — toujours honnête
  // avec l'utilisateur sur laquelle des deux méthodes a été utilisée.
  let optimalOrder;
  let methodLabel;
  if (iaToggleEl?.checked) {
    const iaOrder = predictOrderIA(driverPos, batch);
    if (iaOrder) {
      optimalOrder = iaOrder;
      methodLabel = 'IA (réseau de neurones)';
    } else {
      optimalOrder = nearestNeighborRoute(driverPos, batch);
      methodLabel = 'algorithme (IA non applicable ici : nombre de passagers hors plage 2-6, ou IA pas encore prête)';
      showToast(`IA non applicable pour ce lot (${batch.length} passager(s) — plage supportée : 2 à ${IA_MAX_PASSAGERS}), algorithme classique utilisé à la place.`, 'info', 5000);
    }
  } else {
    optimalOrder = nearestNeighborRoute(driverPos, batch);
    methodLabel = 'algorithme (plus proche voisin)';
  }

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
    ? `Itinéraire optimisé pour ${optimalOrder.length} passager(s) via ${methodLabel} (capacité max atteinte). ${overflow} passager(s) restent en file pour une prochaine tournée.`
    : `Itinéraire optimisé pour ${optimalOrder.length} passager(s) via ${methodLabel}.`;
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

/* =========================================================
   CARTE + TABLEAU DE BORD — ESPACE ADMIN
   Vue de supervision globale : chauffeurs, demandes en attente,
   compteurs de comptes. Les actions (suspendre/réactiver un
   chauffeur, débloquer une course, annuler une demande) passent
   par les policies RLS "*_admin_update" définies dans
   supabase_setup.sql — elles échoueront silencieusement tant que
   ce script SQL n'a pas été exécuté et que le compte connecté n'a
   pas role = 'admin' dans la table profiles.
========================================================= */
const mapAdmin = new mapboxgl.Map({
  container: 'map-admin',
  style: 'mapbox://styles/mapbox/light-v11',
  center: TANGER_CENTER,
  zoom: 12
});
mapAdmin.addControl(new mapboxgl.NavigationControl(), 'top-right');

let adminChauffeurMarkers = [], adminDemandeMarkers = [];

function renderAdminMap(chauffeurs, demandes) {
  adminChauffeurMarkers.forEach(m => m.remove());
  adminDemandeMarkers.forEach(m => m.remove());
  adminChauffeurMarkers = [];
  adminDemandeMarkers = [];

  chauffeurs.forEach(c => {
    if (c.lat == null || c.lng == null) return;
    const el = document.createElement('div');
    el.className = 'marker-driver';
    el.style.opacity = c.statut === 'disponible' ? '1' : '.45';
    el.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4"><rect x="3" y="9" width="18" height="8" rx="2"/><circle cx="7.5" cy="17" r="1.3"/><circle cx="16.5" cy="17" r="1.3"/></svg>';
    adminChauffeurMarkers.push(new mapboxgl.Marker(el).setLngLat([c.lng, c.lat]).addTo(mapAdmin));
  });

  demandes.forEach(d => {
    const el = document.createElement('div');
    el.className = 'marker-client';
    adminDemandeMarkers.push(new mapboxgl.Marker(el).setLngLat([d.lng, d.lat]).addTo(mapAdmin));
  });
}

function statutPill(statut) {
  if (statut === 'disponible') return '<span class="pill pill-ok">Disponible</span>';
  if (statut === 'en_course') return '<span class="pill pill-course">En course</span>';
  return '<span class="pill pill-off">Suspendu</span>';
}

async function loadAdminDashboard() {
  const listChauffeurs = document.getElementById('admin-chauffeurs-list');
  const listDemandes = document.getElementById('admin-demandes-list');

  const [
    { count: passagerCount, error: ePass },
    { count: chauffeurCount, error: eChauf },
    { data: chauffeurs, error: eChList },
    { data: demandes, error: eDem },
  ] = await Promise.all([
    supabaseClient.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'passager'),
    supabaseClient.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'chauffeur'),
    supabaseClient.from('chauffeurs').select('*').order('created_at', { ascending: false }),
    supabaseClient.from('demandes_course').select('*').eq('statut', 'en_attente').order('created_at', { ascending: true }),
  ]);

  if (ePass || eChauf || eChList || eDem) {
    showToast("Impossible de charger le tableau de bord admin — avez-vous exécuté supabase_setup.sql ?", 'error', 8000);
    return;
  }

  let profilesByChauffeur = new Map();
  if (chauffeurs.length) {
    const { data: profiles } = await supabaseClient
      .from('profiles')
      .select('id, nom, email, telephone')
      .in('id', chauffeurs.map(c => c.user_id).filter(Boolean));
    profilesByChauffeur = new Map((profiles || []).map(p => [p.id, p]));
  }

  document.getElementById('admin-kpi-passagers').textContent = passagerCount ?? 0;
  document.getElementById('admin-kpi-chauffeurs').textContent = chauffeurCount ?? 0;
  document.getElementById('admin-kpi-dispo').textContent = chauffeurs.filter(c => c.statut === 'disponible').length;
  document.getElementById('admin-kpi-demandes').textContent = demandes.length;

  listChauffeurs.innerHTML = chauffeurs.length ? chauffeurs.map(c => {
    const profile = profilesByChauffeur.get(c.user_id);
    const label = profile?.nom || profile?.email || c.immatriculation || 'Chauffeur';
    let actionBtn = '';
    if (c.statut === 'disponible') {
      actionBtn = `<button class="btn-mini danger" data-action="suspend" data-id="${c.id}">Suspendre</button>`;
    } else if (c.statut === 'en_course') {
      actionBtn = `<button class="btn-mini" data-action="unstick" data-id="${c.id}">Débloquer</button>`;
    } else {
      actionBtn = `<button class="btn-mini" data-action="reactivate" data-id="${c.id}">Réactiver</button>`;
    }
    return `<li>
      <div class="al-main"><b>${label}</b><span>${c.immatriculation || 'immat. non renseignée'} · ${c.capacite_places} places</span></div>
      <div class="al-actions">${statutPill(c.statut)}${actionBtn}</div>
    </li>`;
  }).join('') : '<li class="admin-empty">Aucun chauffeur inscrit pour le moment.</li>';

  listDemandes.innerHTML = demandes.length ? demandes.map(d => {
    const waitedMin = Math.round((Date.now() - new Date(d.created_at).getTime()) / 60000);
    return `<li>
      <div class="al-main"><b>${d.lat.toFixed(4)}, ${d.lng.toFixed(4)}</b><span>en attente depuis ${waitedMin} min</span></div>
      <div class="al-actions"><button class="btn-mini danger" data-action="cancel-demande" data-id="${d.id}">Annuler</button></div>
    </li>`;
  }).join('') : '<li class="admin-empty">Aucune demande en attente.</li>';

  renderAdminMap(chauffeurs, demandes);
}

// Délégation d'événements : les boutons d'action sont recréés à chaque
// rafraîchissement, donc on écoute au niveau du parent plutôt que
// d'attacher un listener par bouton.
document.getElementById('admin-chauffeurs-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const actions = {
    suspend: { statut: 'indisponible' },
    reactivate: { statut: 'disponible' },
    unstick: { statut: 'disponible' },
  };
  const update = actions[btn.dataset.action];
  if (!update) return;
  btn.disabled = true;
  const { error } = await supabaseClient.from('chauffeurs').update(update).eq('id', id);
  if (error) {
    showToast("Action refusée : " + error.message + " — vérifiez que votre compte a bien role='admin' dans profiles.", 'error', 8000);
    btn.disabled = false;
    return;
  }
  showToast('Chauffeur mis à jour', 'info', 3000);
  await loadAdminDashboard();
});

document.getElementById('admin-demandes-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action="cancel-demande"]');
  if (!btn) return;
  btn.disabled = true;
  const { error } = await supabaseClient
    .from('demandes_course')
    .update({ statut: 'annulee' })
    .eq('id', btn.dataset.id);
  if (error) {
    showToast("Action refusée : " + error.message, 'error', 8000);
    btn.disabled = false;
    return;
  }
  showToast('Demande annulée', 'info', 3000);
  await loadAdminDashboard();
});

/* =========================================================
   AUTHENTIFICATION — Supabase Auth (email + mot de passe)
   Page d'accueil : choix du rôle (Passager / Chauffeur) puis
   connexion ou inscription. Le rôle est stocké dans les
   métadonnées utilisateur (user_metadata.role).
   ========================================================= */
const viewHome = document.getElementById('view-home');
const topbar = document.querySelector('.topbar');
const tabsNav = document.querySelector('.tabs');
const topbarUser = document.getElementById('topbar-user');
const topbarUserName = document.getElementById('topbar-user-name');
const btnLogout = document.getElementById('btn-logout');
const tabPassagerBtn = document.querySelector('.tab[data-view="passager"]');
const tabChauffeurBtn = document.querySelector('.tab[data-view="chauffeur"]');
const tabAdminBtn = document.querySelector('.tab[data-view="admin"]');
const navCta = document.getElementById('nav-cta');

const roleButtons = document.querySelectorAll('.role-btn');
const modeButtons = document.querySelectorAll('.mode-btn');
const signupFields = document.querySelector('.signup-fields');
const chauffeurFields = document.querySelector('.chauffeur-fields');
const authForm = document.getElementById('auth-form');
const authError = document.getElementById('auth-error');
const authSubmit = document.getElementById('auth-submit');
const authSubmitText = document.getElementById('auth-submit-text');
const authSwitchBtn = document.getElementById('auth-switch-btn');
const authSwitchText = document.getElementById('auth-switch-text');

let selectedRole = 'passager';
let authMode = 'login'; // 'login' | 'signup'

roleButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    roleButtons.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    selectedRole = btn.dataset.role;
    chauffeurFields.classList.toggle('hidden', !(authMode === 'signup' && selectedRole === 'chauffeur'));
  });
});

function setAuthMode(mode) {
  authMode = mode;
  modeButtons.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  signupFields.classList.toggle('hidden', mode !== 'signup');
  chauffeurFields.classList.toggle('hidden', !(mode === 'signup' && selectedRole === 'chauffeur'));
  authSubmitText.textContent = mode === 'signup' ? 'Créer mon compte' : 'Se connecter';
  authSwitchText.textContent = mode === 'signup' ? 'Déjà un compte ?' : 'Pas encore de compte ?';
  authSwitchBtn.textContent = mode === 'signup' ? 'Se connecter' : 'Créer un compte';
  authError.classList.add('hidden');
}
modeButtons.forEach(b => b.addEventListener('click', () => setAuthMode(b.dataset.mode)));
authSwitchBtn.addEventListener('click', () => setAuthMode(authMode === 'signup' ? 'login' : 'signup'));

function showAuthError(msg) {
  authError.textContent = msg;
  authError.classList.remove('hidden');
}

function translateAuthError(msg) {
  if (/Invalid login credentials/i.test(msg)) return 'Email ou mot de passe incorrect.';
  if (/already registered|already exists/i.test(msg)) return 'Un compte existe déjà avec cet email.';
  if (/Password should be|at least 6/i.test(msg)) return 'Le mot de passe doit contenir au moins 6 caractères.';
  if (/Unable to validate email/i.test(msg)) return "Format d'email invalide.";
  return msg;
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.classList.add('hidden');
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;

  authSubmit.disabled = true;
  const originalText = authSubmitText.textContent;
  authSubmitText.textContent = authMode === 'signup' ? 'Création…' : 'Connexion…';

  try {
    if (authMode === 'signup') {
      const name = document.getElementById('auth-name').value.trim();
      const phone = document.getElementById('auth-phone').value.trim();

      const { data, error } = await supabaseClient.auth.signUp({
        email, password,
        options: { data: { role: selectedRole, nom: name, telephone: phone } }
      });
      if (error) throw error;

      if (selectedRole === 'chauffeur' && data.user) {
        const immat = document.getElementById('auth-immat').value.trim();
        const capacite = parseInt(document.getElementById('auth-capacite').value, 10) || 8;
        const conso = parseFloat(document.getElementById('auth-conso').value) || 12;
        const { error: chauffeurError } = await supabaseClient.from('chauffeurs').insert({
          user_id: data.user.id,
          immatriculation: immat || 'À COMPLÉTER',
          capacite_places: capacite,
          consommation_l_100km: conso,
          statut: 'disponible',
          lat: DRIVER_START.lat,
          lng: DRIVER_START.lng
        });
        if (chauffeurError) showToast('Compte créé, mais profil chauffeur incomplet : ' + chauffeurError.message, 'error');
      }

      if (!data.session) {
        showToast('Compte créé ! Vérifiez votre boîte mail pour confirmer votre adresse avant de vous connecter.', 'info', 8000);
        setAuthMode('login');
      } else {
        await onLoginSuccess(data.user);
      }
    } else {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await onLoginSuccess(data.user);
    }
  } catch (err) {
    showAuthError(translateAuthError(err.message || String(err)));
  } finally {
    authSubmit.disabled = false;
    authSubmitText.textContent = originalText;
  }
});

btnLogout.addEventListener('click', async () => {
  await supabaseClient.auth.signOut();
  location.reload();
});

// Bascule l'interface vers l'application une fois l'utilisateur identifié
// (connexion, inscription, ou session déjà active retrouvée au chargement).
// Le rôle affiché vient de la table `profiles` (source de vérité côté base,
// modifiable par SQL pour promouvoir un admin) — les métadonnées du token
// ne servent que de repli si la table n'est pas encore en place.
async function onLoginSuccess(user) {
  let role = user.user_metadata?.role === 'chauffeur' ? 'chauffeur' : 'passager';
  try {
    const { data: profile } = await supabaseClient
      .from('profiles')
      .select('role, nom')
      .eq('id', user.id)
      .single();
    if (profile?.role) role = profile.role;
  } catch (e) {
    // Table profiles pas encore créée (migration SQL non exécutée) : on
    // reste sur le rôle des métadonnées, jamais sur "admin" par défaut.
  }

  viewMarketing.classList.remove('active');
  viewHome.classList.remove('active');
  document.body.classList.remove('on-marketing');
  navCta.classList.add('hidden');
  topbar.classList.remove('logged-out');
  topbarUser.classList.remove('hidden');
  topbarUserName.textContent = user.user_metadata?.nom || user.email;
  tabsNav.classList.remove('hidden');

  tabPassagerBtn.style.display = 'none';
  tabChauffeurBtn.style.display = 'none';
  tabAdminBtn.style.display = 'none';

  if (role === 'admin') {
    tabAdminBtn.style.display = '';
    tabAdminBtn.click();
    await loadAdminDashboard();
  } else if (role === 'chauffeur') {
    tabChauffeurBtn.style.display = '';
    tabChauffeurBtn.click();
    await ensureChauffeur(user.id);
  } else {
    tabPassagerBtn.style.display = '';
    tabPassagerBtn.click();
  }
}

// Vérifie s'il existe déjà une session active au chargement de la page,
// pour éviter de redemander une connexion à chaque visite.
(async () => {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session?.user) {
    await onLoginSuccess(session.user);
  } else {
    showMarketing();
  }
})();
