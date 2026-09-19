#!/usr/bin/env node
/**
 * Seed demo products into catalog_db. Run explicitly — never on boot:
 *
 *   npm run seed            insert products that are missing (by SKU); leave existing ones untouched
 *   npm run seed:update     also overwrite existing seed SKUs with the values below
 *
 * Idempotent: every product is upserted by its unique SKU in ONE bulkWrite,
 * so running it any number of times yields exactly one document per SKU.
 * Prices are integers in paise (₹1,299 → 129900) — see models/product.js.
 */
import mongoose from 'mongoose';
import { loadDotenv, loadConfig, ConfigError } from '../src/config/env.js';
import { Product } from '../src/models/product.js';

const update = process.argv.includes('--update');

// Plausible demo catalogue, 4 categories, INR. Image URLs are deterministic
// placeholders keyed by SKU so cards look consistent across demo runs.
const img = (sku) => `https://picsum.photos/seed/${sku}/600/600`;
const P = (sku, name, category, rupees, description) => ({
  sku, name, category, description, imageUrl: img(sku), currency: 'INR', isActive: true,
  priceInPaise: Math.round(rupees * 100),
});

export const SEED_PRODUCTS = [
  // electronics
  P('ELC-NB-ANC-01', 'Nimbus ANC Over-Ear Headphones', 'electronics', 4999,
    'Active noise cancelling over-ear headphones with 40 mm drivers, 38-hour battery, USB-C fast charge and a foldable travel case.'),
  P('ELC-PB-20K-01', 'Voltra 20000 mAh Power Bank', 'electronics', 1899,
    '20 000 mAh lithium-polymer power bank with 22.5 W fast charging, dual USB-A and one USB-C port. Charges a phone about four times.'),
  P('ELC-SW-FIT-02', 'Pulse Fit 2 Smartwatch', 'electronics', 2799,
    '1.85-inch AMOLED smartwatch with heart-rate and SpO2 monitoring, 100+ sport modes, Bluetooth calling and 7-day battery life.'),
  P('ELC-KB-MECH-65', 'Keystroke 65% Mechanical Keyboard', 'electronics', 3499,
    'Compact 65% mechanical keyboard with hot-swappable tactile switches, PBT keycaps, south-facing RGB and a detachable braided cable.'),
  P('ELC-SPK-BT-05', 'Ripple Portable Bluetooth Speaker', 'electronics', 2299,
    'IPX7 waterproof speaker with 16 W stereo output, 12-hour battery and TWS pairing for a second unit.'),
  // books
  P('BK-FIC-MON-01', 'The Monsoon Ledger', 'books', 399,
    'A literary novel following three generations of a Kochi trading family as the spice routes change around them. Paperback, 412 pages.'),
  P('BK-TEC-DDIA-01', 'Designing Data-Intensive Applications', 'books', 2850,
    'The definitive guide to the architecture of reliable, scalable and maintainable data systems. Hardcover, 616 pages.'),
  P('BK-KID-SKY-01', 'Where the Kites Go', 'books', 299,
    'Illustrated picture book about a girl in Ahmedabad who follows a runaway kite across the city on Uttarayan. Ages 4-8, hardcover.'),
  // home-kitchen
  P('HK-CST-IRON-26', 'Hearth 26 cm Cast Iron Skillet', 'home-kitchen', 1649,
    'Pre-seasoned cast iron skillet, oven-safe to 260 °C, with a pour spout on each side. Improves with every use.'),
  P('HK-KTL-ELC-15', 'Brewline 1.5 L Electric Kettle', 'home-kitchen', 1299,
    '1.5-litre stainless-steel kettle with 1500 W rapid boil, auto shut-off, boil-dry protection and a 360° swivel base.'),
  P('HK-SPC-RACK-12', 'Masala Dabba Spice Box, 12 Jars', 'home-kitchen', 899,
    'Stainless-steel spice box with 12 removable jars, a clear lid and two spoons. Keeps everyday masalas within reach.'),
  // sports
  P('SP-YOGA-MAT-6', 'Asana 6 mm Yoga Mat', 'sports', 1199,
    '6 mm TPE yoga mat, 183 × 61 cm, non-slip both sides, with a carry strap. Free of PVC and latex.'),
  P('SP-BOT-STL-1L', 'Trailhead 1 L Insulated Bottle', 'sports', 999,
    'Double-wall vacuum-insulated stainless-steel bottle. Keeps drinks cold 24 h or hot 12 h. Leak-proof flip lid.'),
  P('SP-BALL-FB-5', 'Striker Match Football, Size 5', 'sports', 1449,
    'Size 5 thermally bonded football with a textured PU surface and butyl bladder for consistent shape and flight.'),
];

async function main() {
  loadDotenv();
  const config = loadConfig();
  console.log(`[seed] connecting to ${config.mongo.dbName} …`);
  await mongoose.connect(config.mongo.uri, { dbName: config.mongo.dbName, serverSelectionTimeoutMS: config.mongo.timeoutMs });
  await Product.syncIndexes();

  // Timestamps are set by hand (timestamps: false) so that a plain re-run
  // writes NOTHING to existing documents — Mongoose would otherwise bump
  // updatedAt on every upsert and the run would not be a true no-op.
  const now = new Date();
  const ops = SEED_PRODUCTS.map((p) => ({
    updateOne: {
      filter: { sku: p.sku },
      update: update
        ? { $set: { ...p, updatedAt: now }, $setOnInsert: { createdAt: now } }
        : { $setOnInsert: { ...p, createdAt: now, updatedAt: now } },
      upsert: true,
      timestamps: false,
    },
  }));
  const result = await Product.bulkWrite(ops, { ordered: false });

  console.log(`[seed] ${SEED_PRODUCTS.length} products in seed file`);
  console.log(`[seed] inserted: ${result.upsertedCount}, updated: ${result.modifiedCount}, already present (untouched): ${SEED_PRODUCTS.length - result.upsertedCount - result.modifiedCount}`);
  console.log(`[seed] total products in ${config.mongo.dbName}: ${await Product.countDocuments()}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  if (err instanceof ConfigError) console.error(`[seed] ${err.message}`);
  else console.error('[seed] failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
