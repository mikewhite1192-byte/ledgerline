// Invented people and businesses. A first name and a last name are paired at random per carrier,
// so no row names a real person; the business names are made up for this demo.

export const FIRST_NAMES = [
  "James", "Maria", "Darnell", "Linda", "Carlos", "Tanya", "Robert", "Mei", "Andre", "Susan",
  "Kevin", "Rosa", "Terrence", "Hannah", "Luis", "Patricia", "Marcus", "Ellen", "Javier", "Brenda",
  "Dwayne", "Keisha", "Tomas", "Gloria", "Victor", "Angela", "Raymond", "Lucia", "Curtis", "Monique",
  "Derek", "Yolanda", "Hector", "Denise", "Wesley", "Ana", "Byron", "Tamika", "Oscar", "Rachel",
] as const;

export const LAST_NAMES = [
  "Abernathy", "Becker", "Calloway", "Dominguez", "Ellison", "Fairbanks", "Gutierrez", "Holloway",
  "Ingram", "Jessup", "Kowalski", "Lindqvist", "Mendoza", "Nakamura", "Okafor", "Pruitt",
  "Quintero", "Rasmussen", "Sandoval", "Thibodeaux", "Underwood", "Vasquez", "Whitfield",
  "Yarborough", "Zeller", "Ashby", "Brannon", "Castellanos", "Delgado", "Easterly", "Fontaine",
  "Garrison", "Hargrove", "Ibarra", "Jernigan", "Kincaid", "Lockhart", "Maddox", "Novak", "Ortega",
] as const;

export type CustomerSeed = { name: string; city: string; state: string };

export const CUSTOMERS: Record<"BR" | "PW", readonly CustomerSeed[]> = {
  BR: [
    { name: "Tanglewood Grocery Supply", city: "Charlotte", state: "NC" },
    { name: "Larkspur Paper Mills", city: "Greensboro", state: "NC" },
    { name: "Cobble Ridge Furniture", city: "Hickory", state: "NC" },
    { name: "Bluefern Beverage Group", city: "Richmond", state: "VA" },
    { name: "Ashgrove Building Products", city: "Raleigh", state: "NC" },
    { name: "Kestrel Bay Seafood Traders", city: "Wilmington", state: "NC" },
    { name: "Millbrook Textile Works", city: "Spartanburg", state: "SC" },
    { name: "Juniper Hollow Foods", city: "Roanoke", state: "VA" },
    { name: "Ironvale Auto Parts", city: "Columbia", state: "SC" },
    { name: "Saltmarsh Packaging", city: "Norfolk", state: "VA" },
    { name: "Pinecrest Home Goods", city: "Durham", state: "NC" },
    { name: "Granite Fork Tire Supply", city: "Greenville", state: "SC" },
  ],
  PW: [
    { name: "Sunbreak Grain Handlers", city: "Wichita", state: "KS" },
    { name: "Bison Creek Feed Supply", city: "Salina", state: "KS" },
    { name: "Cottonwood Draw Meats", city: "Dodge City", state: "KS" },
    { name: "Prairie Lantern Implements", city: "Hutchinson", state: "KS" },
    { name: "Red Mesa Building Supply", city: "Omaha", state: "NE" },
    { name: "Windrow Fertilizer Partners", city: "Grand Island", state: "NE" },
    { name: "Sandhill Bend Dairy", city: "Kearney", state: "NE" },
    { name: "Silver Platte Biofuels", city: "Lincoln", state: "NE" },
    { name: "Flint Hollow Cabinetry", city: "Topeka", state: "KS" },
    { name: "Meadowlark Paper Products", city: "Kansas City", state: "KS" },
    { name: "Ironweed Pipe and Fitting", city: "Emporia", state: "KS" },
    { name: "Coyote Ridge Pet Foods", city: "Garden City", state: "KS" },
  ],
};
