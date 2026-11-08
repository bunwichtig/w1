// defaults.js – Vorschläge für Name, Raum und Passwort im Startmenü (alles bleibt änderbar).

// 100 der beliebtesten Vornamen in Deutschland
export const NAMES = [
  'Emilia', 'Emma', 'Sophia', 'Hannah', 'Mia', 'Lina', 'Mila', 'Ella', 'Leni', 'Clara',
  'Lea', 'Marie', 'Frieda', 'Mathilda', 'Lia', 'Emily', 'Ida', 'Lena', 'Anna', 'Luisa',
  'Laura', 'Lotta', 'Johanna', 'Leonie', 'Charlotte', 'Amelie', 'Sophie', 'Malia', 'Lara', 'Nele',
  'Paula', 'Mira', 'Elena', 'Thea', 'Greta', 'Helena', 'Juna', 'Melina', 'Alina', 'Maja',
  'Pia', 'Zoe', 'Nora', 'Romy', 'Liv', 'Carla', 'Marlene', 'Isabella', 'Julia', 'Sarah',
  'Noah', 'Matteo', 'Leon', 'Luca', 'Paul', 'Elias', 'Finn', 'Ben', 'Emil', 'Felix',
  'Henry', 'Theo', 'Jonas', 'Luis', 'Anton', 'Liam', 'Fiete', 'Leo', 'Louis', 'Max',
  'Milan', 'Jakob', 'Oskar', 'Moritz', 'Mats', 'Julian', 'Karl', 'Jonah', 'Elia', 'Alexander',
  'David', 'Lukas', 'Samuel', 'Tim', 'Niklas', 'Jan', 'Tom', 'Mika', 'Levi', 'Malte',
  'Ole', 'Emilio', 'Philipp', 'Hannes', 'Vincent', 'Johann', 'Lio', 'Linus', 'Benjamin', 'Leonard',
];

// 100 Beispiel-Raumnamen
export const ROOMS = [
  'Freitagsrunde', 'Kumpelgruppe', 'Wanderer', 'Arbeitskollegen', 'Stammtisch', 'Spieleabend', 'Zockerbande', 'WG-Runde', 'Familienrunde', 'Nachbarschaft',
  'Sonntagsclub', 'Kegelclub', 'Laufgruppe', 'Feierabendrunde', 'Kaffeeklatsch', 'Studienfreunde', 'Klassentreffen', 'Fussballfreunde', 'Radlergruppe', 'Bergfreunde',
  'Campingfreunde', 'Grillmeister', 'Doppelkopfrunde', 'Skatrunde', 'Mittagspause', 'Teamabend', 'Projektgruppe', 'Lerngruppe', 'Elternabend', 'Gartenfreunde',
  'Nachtschicht', 'Kneipenrunde', 'Bandprobe', 'Chorfreunde', 'Vereinsheim', 'Turnhalle', 'Dorfjugend', 'Abiturjahrgang', 'Ersties', 'Semesterrunde',
  'Kochclub', 'Weinrunde', 'Bierfreunde', 'Brettspielclub', 'Quizrunde', 'Kinoabend', 'Serienjunkies', 'Couchpotatoes', 'Nachteulen', 'Morgenmuffel',
  'Sofahelden', 'Pausenhof', 'Hinterhofbande', 'Strandclique', 'Seglerclub', 'Angelfreunde', 'Kletterclub', 'Skifahrer', 'Almrunde', 'Ferienlager',
  'Urlaubsclique', 'Roadtrip', 'Junggesellen', 'Trauzeugen', 'Cousinen', 'Geschwister', 'Schwiegerfamilie', 'Oma und Opa', 'Patenkinder', 'Krabbelgruppe',
  'Kitaeltern', 'Fahrgemeinschaft', 'Pendlerzug', 'Homeoffice', 'Kaffeeecke', 'Montagsmeeting', 'IT-Abteilung', 'Azubis', 'Werkstatt', 'Lagerhalle',
  'Praxisteam', 'Lehrerzimmer', 'Feuerwehr', 'Rettungswache', 'Tanzgruppe', 'Yogakurs', 'Fitnessstudio', 'Joggingtreff', 'Tennisclub', 'Handballteam',
  'Mopedfreunde', 'Oldtimerclub', 'Gamerclan', 'Lanparty', 'Zeltlager', 'Pfadfinder', 'Nachbarn von oben', 'Hausgemeinschaft', 'Balkonrunde', 'Mitternachtsclub',
];

function rnd(n) {
  try {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] % n;
  } catch {
    return Math.floor(Math.random() * n);
  }
}
const pick = (list) => list[rnd(list.length)];

export const randomName = () => pick(NAMES);
export const randomRoom = () => pick(ROOMS);

// Drei Ziffern, ein Punkt, drei Buchstaben, z. B. „482.kfm“
export function randomPassword() {
  let digits = '';
  let letters = '';
  for (let i = 0; i < 3; i++) digits += rnd(10);
  for (let i = 0; i < 3; i++) letters += 'abcdefghijklmnopqrstuvwxyz'[rnd(26)];
  return `${digits}.${letters}`;
}
