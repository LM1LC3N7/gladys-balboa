// -----------------------------------------------------------------------------
// Runtime texts (English and French): device, feature and option names, the
// status of the integration, the answers of the button and the command errors.
// -----------------------------------------------------------------------------

import { FEATURES as F } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

export const join = (parts) =>
  both(parts.map((p) => p.en).join(' '), parts.map((p) => p.fr).join(' '));

/** "45 s", "5 min", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  return both(`${minutes} min`, `${minutes} min`);
}

export const DEVICE_NAME = both('Balboa spa', 'Spa Balboa');

const numbered = (en, fr) => (n) => both(`${en} ${n}`, `${fr} ${n}`);

export const FEATURE_NAMES = {
  [F.WATER_TEMPERATURE]: both('Water temperature', "Température de l'eau"),
  [F.TARGET_TEMPERATURE]: both('Setpoint', 'Consigne'),
  [F.HEATING]: both('Heating', 'Chauffe'),
  [F.HEAT_MODE]: both('Heat mode', 'Mode de chauffe'),
  [F.STATUS]: both('Spa status', 'État du spa'),
  [F.TEMPERATURE_RANGE]: both('Temperature range', 'Plage de température'),
  [F.FILTER_1]: both('Filter cycle 1', 'Cycle de filtration 1'),
  [F.FILTER_2]: both('Filter cycle 2', 'Cycle de filtration 2'),
  [F.CIRCULATION_PUMP]: both('Circulation pump', 'Pompe de circulation'),
  [F.PUMP]: numbered('Pump', 'Pompe'),
  [F.BLOWER]: numbered('Blower', 'Souffleur'),
  [F.LIGHT]: numbered('Light', 'Éclairage'),
  [F.AUX]: numbered('Auxiliary', 'Auxiliaire'),
  [F.MISTER]: numbered('Mister', 'Brumisateur'),
};

export const OPTION_NAMES = {
  off: both('Off', 'Arrêt'),
  on: both('On', 'Marche'),
  low: both('Low', 'Lent'),
  medium: both('Medium', 'Moyen'),
  high: both('High', 'Rapide'),
  ready: both('Ready (keeps the setpoint)', 'Prêt (maintient la consigne)'),
  rest: both('Rest (heats during filtration only)', 'Repos (chauffe pendant la filtration)'),
};

export const STATE_TEXTS = {
  spa: {
    running: both('Running', 'En marche'),
    initializing: both('Starting', 'Démarrage'),
    hold: both('Hold (paused)', 'Pause (hold)'),
    'ab-temps': both('Sensor test (A/B)', 'Test des sondes (A/B)'),
    test: both('Test mode', 'Mode test'),
    unknown: both('Unknown state', 'État inconnu'),
  },
  heatMode: {
    ready: both('ready', 'prêt'),
    rest: both('rest', 'repos'),
    'ready-in-rest': both('ready in rest', 'prêt en repos'),
  },
  heatState: {
    off: both('not heating', 'ne chauffe pas'),
    heating: both('heating', 'chauffe'),
    waiting: both('heating soon', 'chauffe bientôt'),
  },
  range: {
    low: both('Low', 'Basse'),
    high: both('High', 'Haute'),
  },
  wifi: {
    'spa-not-communicating': both(
      'the spa does not answer the module',
      'le spa ne répond pas au module',
    ),
    startup: both('module starting', 'module en démarrage'),
    prime: both('priming', 'amorçage'),
    hold: both('hold', 'pause'),
    panel: both('panel in use', 'panneau en cours d’utilisation'),
  },
  offline: both('Spa unreachable', 'Spa injoignable'),
};

/** The integration status, the button and the logs a user may read. */
export const T = {
  noAddress: both(
    'Enter the IP address of the Wi-Fi module of your spa, then save.',
    "Saisissez l'adresse IP du module Wi-Fi de votre spa, puis enregistrez.",
  ),
  invalid: (typed) =>
    both(
      `Invalid address: ${typed} (an IPv4 address or a host name, with an optional port).`,
      `Adresse invalide : ${typed} (une adresse IPv4 ou un nom d'hôte, avec un port en option).`,
    ),
  connecting: both('Connecting to the spa…', 'Connexion au spa…'),
  waiting: both(
    'Connected to the Wi-Fi module, waiting for the spa…',
    'Connecté au module Wi-Fi, en attente du spa…',
  ),
  connected: (model) =>
    model
      ? both(`Connected: Balboa ${model}.`, `Connecté : Balboa ${model}.`)
      : both('Connected to the spa.', 'Connecté au spa.'),
  unreachable: (address, reason, wait) =>
    both(
      `No connection to the spa at ${address} (${reason}; next try in ${wait.en}). Check the address, and that no other app (Balboa app on the local network, Home Assistant…) keeps the module busy.`,
      `Pas de connexion au spa ${address} (${reason} ; nouvel essai dans ${wait.fr}). Vérifiez l'adresse, et qu'aucune autre application (appli Balboa en local, Home Assistant…) n'occupe le module.`,
    ),
  test: {
    cooldown: both('Tested less than 10 s ago.', 'Testé il y a moins de 10 s.'),
  },
};

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  heatingDisabled: both(
    'Heating commands are disabled: turn on "Allow the heating commands" in the configuration of the integration. Not sent.',
    "Les commandes de chauffage sont désactivées : activez « Autoriser les commandes de chauffage » dans la configuration de l'intégration. Non envoyée.",
  ),
  jetsDisabled: both(
    'Pump and blower commands are disabled (except "Off"): turn on "Allow the pumps" in the configuration of the integration. Not sent.',
    "Les commandes des pompes et souffleurs sont désactivées (sauf « Arrêt ») : activez « Autoriser les pompes » dans la configuration de l'intégration. Non envoyée.",
  ),
  lightsDisabled: both(
    'Turning the lights on is disabled in the configuration of the integration. Not sent.',
    "L'allumage de l'éclairage est désactivé dans la configuration de l'intégration. Non envoyée.",
  ),
  badValue: both('Unexpected value: not sent.', 'Valeur inattendue : non envoyée.'),
  badNumber: both(
    'The setpoint must be a number: not sent.',
    'La consigne doit être un nombre : non envoyée.',
  ),
  badStep: both(
    'The setpoint must be a multiple of 0.5 °C: not sent.',
    'La consigne doit être un multiple de 0,5 °C : non envoyée.',
  ),
  cap: (cap) =>
    both(
      `The spa setpoint is capped at ${cap} °C (see "Setpoint ceiling" in the configuration, 40 °C at most): not sent.`,
      `La consigne du spa est plafonnée à ${String(cap).replace('.', ',')} °C (voir « Plafond de la consigne » dans la configuration, 40 °C au plus) : non envoyée.`,
    ),
  outOfRange: (min, max) =>
    both(
      `The spa accepts a setpoint between ${min} and ${max} °C in its current range: not sent.`,
      `Le spa accepte une consigne entre ${String(min).replace('.', ',')} et ${String(max).replace('.', ',')} °C dans sa plage actuelle : non envoyée.`,
    ),
  notConnected: both(
    'The spa is not connected: not sent.',
    "Le spa n'est pas connecté : non envoyée.",
  ),
  unknownDevice: both(
    'This device is not the spa connected now: not sent.',
    "Cet appareil n'est pas le spa connecté actuellement : non envoyée.",
  ),
  noFreshState: both(
    'The spa did not send its state just now: not sent.',
    "Le spa n'a pas envoyé son état à l'instant : non envoyée.",
  ),
  missingValue: both(
    'The spa did not give the current value of this setting: not sent.',
    "Le spa n'a pas donné la valeur actuelle de ce réglage : non envoyée.",
  ),
  notThere: both(
    'The spa does not report this equipment: not sent.',
    'Le spa ne signale pas cet équipement : non envoyée.',
  ),
  stillRunning: both(
    'Another command to the spa is still running: not sent.',
    'Une autre commande vers le spa est encore en cours : non envoyée.',
  ),
  moving: both(
    'The previous command on this equipment is not confirmed yet: not sent.',
    "La commande précédente sur cet équipement n'est pas encore confirmée : non envoyée.",
  ),
  cancelled: both('Cancelled by a stop command.', "Annulée par une commande d'arrêt."),
  tooSlow: both(
    'No time left to send the command: not sent.',
    'Plus le temps d’envoyer la commande : non envoyée.',
  ),
  notSent: (reason) =>
    both(
      `The spa could not be reached (${reason}): not sent.`,
      `Le spa n'a pas pu être joint (${reason}) : non envoyée.`,
    ),
  sentUnconfirmed: both(
    'Command sent, without confirmation: check the spa in a few seconds.',
    'Commande envoyée, sans confirmation : vérifiez le spa dans quelques secondes.',
  ),
};
