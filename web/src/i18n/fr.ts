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
    noneRefused: 'aucun refus',
    refused: '{n} refusés',
    perMin: '{n}/min',
  },

  status: {
    heading: 'Maintenant',
    healthy: 'Tout va bien',
    busy: 'Chargé',
    behind: 'En retard',
    stalled: 'Bloqué',
    backingOff: 'En pause',
    allKeepingUp: 'tous les niveaux suivent',
    nothingQueued: 'rien en attente',
    levelWaiting: '{level} attend depuis {v}',
    rateLimited: 'limite de débit osu! · {v} restantes',
    bucket: 'Réserve partagée',
    reserve: '{n} réservés',
    inFlight: 'En cours',
    queued: 'En attente',
    ceiling: '{n}/min en soutenu',
    refusedBreakdown: 'Refusés : {rate} limite de débit · {challenge} vérification · {token} par jeton',
  },

  levels: {
    heading: 'Niveaux de priorité',
    level: 'Priorité',
    health: 'État',
    rateShare: 'Part du débit',
    shareValue: '{pct} % · {n}/min',
    bank: 'Réserve',
    queued: 'En attente',
    oldestWait: 'Attente max.',
    latencyMed: 'Médiane',
    latencyAvg: 'Moyenne',
    latencyHint: 'Temps total attendu par le client sur la dernière heure : notre file plus osu!.',
    idle: 'inactif',
    keepingUp: 'suit',
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
    ceiling: 'plafond soutenu',
    ariaLabel: 'Requêtes par intervalle, groupées par client',
  },

  playfield: {
    ariaLabel: 'Requêtes en attente sur cinq couloirs de priorité, la plus proche du départ en bas',
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
