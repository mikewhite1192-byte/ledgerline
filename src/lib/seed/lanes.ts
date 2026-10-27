// The roads each carrier runs: real US cities, the states a truck crosses in driving order, and
// whole loaded miles per state (close to the real routes; this is demo data, not a mileage
// guide). Each lane runs both ways. A load adds its empty miles to the first state, the deadhead
// to the pickup, so a load's state miles always sum to loaded + empty miles.

export type Place = { city: string; state: string };
export type StateMiles = readonly [state: string, miles: number];
export type Lane = { from: Place; to: Place; states: readonly StateMiles[] };

function lane(
  fromCity: string,
  fromState: string,
  toCity: string,
  toState: string,
  states: StateMiles[],
): Lane {
  return { from: { city: fromCity, state: fromState }, to: { city: toCity, state: toState }, states };
}

export function reverseLane(l: Lane): Lane {
  return { from: l.to, to: l.from, states: [...l.states].reverse() };
}

export function laneMiles(l: Lane): number {
  return l.states.reduce((n, [, miles]) => n + miles, 0);
}

export type CarrierLanes = { regional: readonly Lane[]; local: readonly Lane[] };

export const LANES: Record<"BR" | "PW", CarrierLanes> = {
  BR: {
    regional: [
      lane("Charlotte", "NC", "Atlanta", "GA", [["NC", 32], ["SC", 106], ["GA", 107]]),
      lane("Charlotte", "NC", "Nashville", "TN", [["NC", 190], ["TN", 220]]),
      lane("Greensboro", "NC", "Columbus", "OH", [["NC", 60], ["VA", 95], ["WV", 190], ["OH", 125]]),
      lane("Raleigh", "NC", "Philadelphia", "PA", [
        ["NC", 78], ["VA", 186], ["MD", 106], ["DE", 23], ["PA", 12],
      ]),
      lane("Fayetteville", "NC", "Trenton", "NJ", [
        ["NC", 75], ["VA", 179], ["MD", 79], ["DE", 23], ["NJ", 56],
      ]),
      lane("Wilmington", "NC", "Savannah", "GA", [["NC", 55], ["SC", 210], ["GA", 15]]),
      lane("Richmond", "VA", "Baltimore", "MD", [["VA", 105], ["MD", 45]]),
      lane("Roanoke", "VA", "Harrisburg", "PA", [["VA", 190], ["WV", 26], ["MD", 12], ["PA", 75]]),
      lane("Columbia", "SC", "Knoxville", "TN", [["SC", 130], ["NC", 115], ["TN", 70]]),
      lane("Greenville", "SC", "Cincinnati", "OH", [
        ["SC", 30], ["NC", 70], ["TN", 150], ["KY", 190], ["OH", 5],
      ]),
      lane("Norfolk", "VA", "Newark", "NJ", [["VA", 75], ["MD", 100], ["DE", 85], ["NJ", 115]]),
      lane("Charlotte", "NC", "Richmond", "VA", [["NC", 175], ["VA", 115]]),
      lane("Raleigh", "NC", "Atlanta", "GA", [["NC", 197], ["SC", 106], ["GA", 107]]),
      lane("Durham", "NC", "Pittsburgh", "PA", [["NC", 55], ["VA", 115], ["WV", 200], ["PA", 75]]),
      lane("Spartanburg", "SC", "Chattanooga", "TN", [["SC", 80], ["GA", 218], ["TN", 5]]),
      lane("Winston-Salem", "NC", "Hagerstown", "MD", [["NC", 30], ["VA", 285], ["WV", 26], ["MD", 10]]),
      lane("Columbia", "SC", "Philadelphia", "PA", [
        ["SC", 75], ["NC", 225], ["VA", 186], ["MD", 106], ["DE", 23], ["PA", 12],
      ]),
      lane("Hickory", "NC", "Akron", "OH", [["NC", 70], ["VA", 75], ["WV", 190], ["OH", 120]]),
    ],
    local: [
      lane("Charlotte", "NC", "Concord", "NC", [["NC", 25]]),
      lane("Charlotte", "NC", "Gastonia", "NC", [["NC", 22]]),
      lane("Charlotte", "NC", "Rock Hill", "SC", [["NC", 15], ["SC", 12]]),
      lane("Raleigh", "NC", "Durham", "NC", [["NC", 25]]),
      lane("Raleigh", "NC", "Wilson", "NC", [["NC", 48]]),
      lane("Greensboro", "NC", "High Point", "NC", [["NC", 18]]),
    ],
  },
  PW: {
    regional: [
      lane("Wichita", "KS", "Oklahoma City", "OK", [["KS", 50], ["OK", 110]]),
      lane("Omaha", "NE", "Des Moines", "IA", [["NE", 5], ["IA", 130]]),
      lane("Kansas City", "KS", "St. Louis", "MO", [["KS", 5], ["MO", 245]]),
      lane("Wichita", "KS", "Dallas", "TX", [["KS", 50], ["OK", 235], ["TX", 80]]),
      lane("Salina", "KS", "Denver", "CO", [["KS", 255], ["CO", 180]]),
      lane("Lincoln", "NE", "Chicago", "IL", [["NE", 55], ["IA", 305], ["IL", 165]]),
      lane("Topeka", "KS", "Tulsa", "OK", [["KS", 140], ["OK", 95]]),
      lane("Omaha", "NE", "Kansas City", "MO", [["NE", 5], ["IA", 50], ["MO", 130]]),
      lane("Grand Island", "NE", "Denver", "CO", [["NE", 260], ["CO", 140]]),
      lane("Dodge City", "KS", "Amarillo", "TX", [["KS", 55], ["OK", 50], ["TX", 95]]),
      lane("Hutchinson", "KS", "Springfield", "MO", [["KS", 215], ["MO", 75]]),
      lane("Kearney", "NE", "Sioux City", "IA", [["NE", 245], ["IA", 5]]),
      lane("Emporia", "KS", "Houston", "TX", [["KS", 95], ["OK", 235], ["TX", 330]]),
      lane("Garden City", "KS", "Pueblo", "CO", [["KS", 70], ["CO", 175]]),
      lane("Omaha", "NE", "Peoria", "IL", [["NE", 5], ["IA", 300], ["IL", 95]]),
      lane("Lawrence", "KS", "Columbia", "MO", [["KS", 40], ["MO", 125]]),
      lane("Norfolk", "NE", "Cedar Rapids", "IA", [["NE", 70], ["IA", 275]]),
      lane("Liberal", "KS", "Wichita Falls", "TX", [["KS", 5], ["OK", 230], ["TX", 15]]),
    ],
    local: [
      lane("Wichita", "KS", "Newton", "KS", [["KS", 27]]),
      lane("Wichita", "KS", "Hutchinson", "KS", [["KS", 52]]),
      lane("Omaha", "NE", "Council Bluffs", "IA", [["NE", 5], ["IA", 5]]),
      lane("Omaha", "NE", "Fremont", "NE", [["NE", 37]]),
      lane("Kansas City", "KS", "Olathe", "KS", [["KS", 22]]),
      lane("Lincoln", "NE", "Seward", "NE", [["NE", 28]]),
    ],
  },
};

// The Blue Ridge hero's open week runs three fixed lanes (indexes into LANES.BR.regional).
export const HERO_LANES = { raleighPhiladelphia: 3, fayettevilleTrenton: 4, wilmingtonSavannah: 5 };
