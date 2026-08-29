import { db, sql } from './client.js';
import { menuCategories, menuItemVariants, menuItems } from './schema.js';

// PLACEHOLDER DATA — this whole catalogue is invented English filler and is
// scheduled to be replaced wholesale by a loader over the real, harvested
// Portofino menu. It exists only so a fresh local database has something to
// serve. Do not treat any of it as Portofino's menu.
//
// `id` is a stable slug — the mobile app builds its UI Bridge ids from it
// (menu-add-<id>). Prices are in cents (EUR) and live on variants, never on
// the item.
type SeedCategory = { id: string; label: string; labelEn: string };

type SeedItem = {
  id: string;
  name: string;
  description: string;
  categoryId: string;
  price: number;
};

const CATEGORIES: SeedCategory[] = [
  { id: 'pizza', label: 'Pizza', labelEn: 'Pizza' },
  { id: 'sides', label: 'Beilagen', labelEn: 'Sides' },
  { id: 'drinks', label: 'Getränke', labelEn: 'Drinks' },
  { id: 'desserts', label: 'Desserts', labelEn: 'Desserts' },
];

const MENU: SeedItem[] = [
  // Pizze
  { id: 'margherita', name: 'Margherita', description: 'San Marzano tomato, fior di latte, fresh basil, EVOO.', categoryId: 'pizza', price: 990 },
  { id: 'marinara', name: 'Marinara', description: 'Tomato, garlic, oregano, EVOO. No cheese — the classic.', categoryId: 'pizza', price: 890 },
  { id: 'diavola', name: 'Diavola', description: 'Tomato, mozzarella, spicy salami, chilli.', categoryId: 'pizza', price: 1190 },
  { id: 'prosciutto-funghi', name: 'Prosciutto e Funghi', description: 'Tomato, mozzarella, cooked ham, mushrooms.', categoryId: 'pizza', price: 1290 },
  { id: 'quattro-formaggi', name: 'Quattro Formaggi', description: 'Mozzarella, gorgonzola, fontina, grana padano.', categoryId: 'pizza', price: 1290 },
  { id: 'capricciosa', name: 'Capricciosa', description: 'Tomato, mozzarella, ham, artichoke, mushroom, olives.', categoryId: 'pizza', price: 1350 },
  { id: 'vegetariana', name: 'Vegetariana', description: 'Tomato, mozzarella, grilled seasonal vegetables.', categoryId: 'pizza', price: 1190 },
  { id: 'quattro-stagioni', name: 'Quattro Stagioni', description: 'Ham, mushroom, artichoke, olives — four seasons.', categoryId: 'pizza', price: 1390 },

  // Sides
  { id: 'garlic-bread', name: 'Garlic Bread', description: 'Wood-fired dough, garlic butter, parsley.', categoryId: 'sides', price: 490 },
  { id: 'bruschetta', name: 'Bruschetta', description: 'Toasted bread, tomato, basil, garlic, EVOO.', categoryId: 'sides', price: 590 },
  { id: 'insalata-mista', name: 'Insalata Mista', description: 'Mixed leaves, tomato, cucumber, house dressing.', categoryId: 'sides', price: 690 },
  { id: 'olive', name: 'Olive Ascolane', description: 'Breaded, stuffed, fried green olives.', categoryId: 'sides', price: 640 },

  // Drinks
  { id: 'acqua-panna', name: 'Acqua Panna 0.5L', description: 'Still mineral water.', categoryId: 'drinks', price: 250 },
  { id: 'san-pellegrino', name: 'S. Pellegrino 0.5L', description: 'Sparkling mineral water.', categoryId: 'drinks', price: 250 },
  { id: 'coca-cola', name: 'Coca-Cola 0.33L', description: 'Chilled classic.', categoryId: 'drinks', price: 290 },
  { id: 'limonata', name: 'Limonata 0.33L', description: 'Italian sparkling lemonade.', categoryId: 'drinks', price: 320 },
  { id: 'birra-moretti', name: 'Birra Moretti 0.33L', description: 'Italian lager.', categoryId: 'drinks', price: 390 },

  // Dolci
  { id: 'tiramisu', name: 'Tiramisù', description: 'Mascarpone, espresso, cocoa, savoiardi.', categoryId: 'desserts', price: 590 },
  { id: 'panna-cotta', name: 'Panna Cotta', description: 'Vanilla cream, berry coulis.', categoryId: 'desserts', price: 550 },
  { id: 'gelato', name: 'Gelato (3 scoops)', description: 'Ask your server for today’s flavours.', categoryId: 'desserts', price: 490 },
];

export async function seedMenu(): Promise<number> {
  let categoryOrder = 0;
  for (const category of CATEGORIES) {
    const row = {
      id: category.id,
      label: category.label,
      labelEn: category.labelEn,
      sortOrder: categoryOrder++,
    };
    await db
      .insert(menuCategories)
      .values(row)
      .onConflictDoUpdate({ target: menuCategories.id, set: row });
  }

  let order = 0;
  for (const item of MENU) {
    const row = {
      id: item.id,
      number: null,
      name: item.name,
      nameEn: null,
      description: item.description,
      descriptionEn: null,
      categoryId: item.categoryId,
      allergenCodes: [] as string[],
      available: true,
      sortOrder: order++,
    };
    // Idempotent upsert so re-running seed just refreshes the menu.
    await db
      .insert(menuItems)
      .values(row)
      .onConflictDoUpdate({ target: menuItems.id, set: row });

    // Every priced thing is a variant; this filler catalogue has exactly one
    // per item. The real menu has two or three for most items.
    const variant = {
      id: `${item.id}-standard`,
      itemId: item.id,
      label: 'Standard',
      sortOrder: 0,
      priceCents: item.price,
    };
    await db
      .insert(menuItemVariants)
      .values(variant)
      .onConflictDoUpdate({ target: menuItemVariants.id, set: variant });
  }
  return MENU.length;
}

// Allow running standalone: `npm run db:seed`.
if (import.meta.url === `file://${process.argv[1]}`) {
  seedMenu()
    .then((n) => {
      console.log(`Seeded ${n} menu items.`);
      return sql.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
