import type { MenuCategory } from '../types.js';
import { db, sql } from './client.js';
import { menuItems } from './schema.js';

// The Portofino menu. Prices are in cents (EUR). `id` is a stable slug — the
// mobile app builds its UI Bridge ids from it (menu-add-<id>).
type SeedItem = {
  id: string;
  name: string;
  description: string;
  category: MenuCategory;
  price: number;
  vegetarian?: boolean;
  spicy?: boolean;
};

const MENU: SeedItem[] = [
  // Pizze
  { id: 'margherita', name: 'Margherita', description: 'San Marzano tomato, fior di latte, fresh basil, EVOO.', category: 'pizza', price: 990, vegetarian: true },
  { id: 'marinara', name: 'Marinara', description: 'Tomato, garlic, oregano, EVOO. No cheese — the classic.', category: 'pizza', price: 890, vegetarian: true },
  { id: 'diavola', name: 'Diavola', description: 'Tomato, mozzarella, spicy salami, chilli.', category: 'pizza', price: 1190, spicy: true },
  { id: 'prosciutto-funghi', name: 'Prosciutto e Funghi', description: 'Tomato, mozzarella, cooked ham, mushrooms.', category: 'pizza', price: 1290 },
  { id: 'quattro-formaggi', name: 'Quattro Formaggi', description: 'Mozzarella, gorgonzola, fontina, grana padano.', category: 'pizza', price: 1290, vegetarian: true },
  { id: 'capricciosa', name: 'Capricciosa', description: 'Tomato, mozzarella, ham, artichoke, mushroom, olives.', category: 'pizza', price: 1350 },
  { id: 'vegetariana', name: 'Vegetariana', description: 'Tomato, mozzarella, grilled seasonal vegetables.', category: 'pizza', price: 1190, vegetarian: true },
  { id: 'quattro-stagioni', name: 'Quattro Stagioni', description: 'Ham, mushroom, artichoke, olives — four seasons.', category: 'pizza', price: 1390 },

  // Sides
  { id: 'garlic-bread', name: 'Garlic Bread', description: 'Wood-fired dough, garlic butter, parsley.', category: 'sides', price: 490, vegetarian: true },
  { id: 'bruschetta', name: 'Bruschetta', description: 'Toasted bread, tomato, basil, garlic, EVOO.', category: 'sides', price: 590, vegetarian: true },
  { id: 'insalata-mista', name: 'Insalata Mista', description: 'Mixed leaves, tomato, cucumber, house dressing.', category: 'sides', price: 690, vegetarian: true },
  { id: 'olive', name: 'Olive Ascolane', description: 'Breaded, stuffed, fried green olives.', category: 'sides', price: 640 },

  // Drinks
  { id: 'acqua-panna', name: 'Acqua Panna 0.5L', description: 'Still mineral water.', category: 'drinks', price: 250, vegetarian: true },
  { id: 'san-pellegrino', name: 'S. Pellegrino 0.5L', description: 'Sparkling mineral water.', category: 'drinks', price: 250, vegetarian: true },
  { id: 'coca-cola', name: 'Coca-Cola 0.33L', description: 'Chilled classic.', category: 'drinks', price: 290 },
  { id: 'limonata', name: 'Limonata 0.33L', description: 'Italian sparkling lemonade.', category: 'drinks', price: 320, vegetarian: true },
  { id: 'birra-moretti', name: 'Birra Moretti 0.33L', description: 'Italian lager.', category: 'drinks', price: 390 },

  // Dolci
  { id: 'tiramisu', name: 'Tiramisù', description: 'Mascarpone, espresso, cocoa, savoiardi.', category: 'desserts', price: 590, vegetarian: true },
  { id: 'panna-cotta', name: 'Panna Cotta', description: 'Vanilla cream, berry coulis.', category: 'desserts', price: 550, vegetarian: true },
  { id: 'gelato', name: 'Gelato (3 scoops)', description: 'Ask your server for today’s flavours.', category: 'desserts', price: 490, vegetarian: true },
];

export async function seedMenu(): Promise<number> {
  let order = 0;
  for (const item of MENU) {
    const row = {
      id: item.id,
      name: item.name,
      description: item.description,
      category: item.category,
      price: item.price,
      vegetarian: item.vegetarian ?? false,
      spicy: item.spicy ?? false,
      available: true,
      sortOrder: order++,
    };
    // Idempotent upsert so re-running seed just refreshes the menu.
    await db
      .insert(menuItems)
      .values(row)
      .onConflictDoUpdate({ target: menuItems.id, set: row });
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
