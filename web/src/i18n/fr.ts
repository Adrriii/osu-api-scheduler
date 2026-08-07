import type { Dict } from './index.js';

export const fr: Dict = {
  title: 'Planificateur de requêtes API osu!',
  live: 'connecté',
  connecting: 'connexion…',
  reconnecting: 'reconnexion…',
  signOut: 'déconnexion',

  tiles: {
    lastHour: 'Dernière heure',
    last24h: 'Dernières 24 heures',
    last30d: 'Derniers 30 jours',
    sustainedRate: 'Débit soutenu',
    noneRefused: 'aucun refus',
    refused: '{n} refusés',
    avgWait: 'attente moy. {v}',
    errorResponses: '{n} réponses en erreur',
    queued: '{n} en attente',
    perMin: '{n}/min',
  },

  budget: {
    heading: 'Budget',
    tokensBanked: 'Réserve partagée',
    inFlight: 'En cours',
    queued: 'En attente',
    backoff: 'Pause',
    none: '—',
    reserveNote: '{n} réservés aux requêtes sensibles à la latence',
    refusedBreakdown: 'Refusés : {rate} limite de débit · {challenge} vérification · {token} par jeton',
  },

  levels: {
    heading: 'Niveaux de priorité',
    level: 'Priorité',
    health: 'État',
    share: 'Part',
    guaranteed: 'Garanti',
    queued: 'En attente',
    oldestWait: 'Attente max.',
    banked: 'Réserve',
    latency: 'Latence, dernière heure',
    latencyHint: 'Moyenne et médiane du temps attendu au total par le client.',
    idle: 'inactif',
    keepingUp: 'actif',
    busy: 'chargé',
    behind: 'en retard',
    stalled: 'bloqué',
  },

  usage: {
    heading: 'Utilisation de l’API',
    hour: 'Heure',
    day: 'Jour',
    month: 'Mois',
    year: 'Année',
    empty: 'Aucune requête enregistrée sur cette période.',
    caption: '{total} requêtes · une barre par {bucket}',
    other: 'Autres',
    ariaLabel: 'Requêtes par intervalle, groupées par client',
  },

  consumers: {
    heading: 'Par client',
    consumer: 'Client',
    requests: 'Requêtes',
    share: 'Part',
    avgWait: 'Attente moy.',
    empty: 'Rien pour l’instant.',
  },

  queue: {
    heading: 'File actuelle',
    empty: '— vide',
    waitingCount: '— {n} en attente',
    waitingTruncated: '— {n} en attente, {shown} affichées',
    position: '#',
    path: 'Chemin',
    waiting: 'Attente',
    none: 'Rien en attente.',
  },

  feed: {
    heading: 'Requêtes en direct',
    time: 'Heure',
    status: 'Statut',
    waited: 'Attendu',
  },

  footer: {
    name: "Planificateur d'API osu! {version}",
    licence: 'AGPL-3.0',
    source: 'code source',
  },
  units: { seconds: '{n} s', minutes: '{n} min', hours: '{n} h', days: '{n} j' },
  error: { load: 'Impossible de charger les données du tableau de bord.' },
};
