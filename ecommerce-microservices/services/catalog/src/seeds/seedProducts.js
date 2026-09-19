/**
 * Seed Script
 *
 * Inserts 3 dummy products into MongoDB if the products collection is empty.
 * Called once at application startup.
 */

const Product = require("../models/Product");

const dummyProducts = [
  {
    name: "Wireless Bluetooth Headphones",
    description:
      "Over-ear noise-cancelling headphones with 30-hour battery life and premium sound quality.",
    price: 79.99,
  },
  {
    name: "Mechanical Keyboard",
    description:
      "RGB backlit mechanical keyboard with Cherry MX Blue switches and aluminium frame.",
    price: 129.99,
  },
  {
    name: "USB-C Hub Adapter",
    description:
      "7-in-1 USB-C hub with HDMI 4K, USB 3.0, SD card reader, and 100W power delivery.",
    price: 34.99,
  },
];

async function seedProducts() {
  try {
    const count = await Product.countDocuments();

    if (count === 0) {
      const inserted = await Product.insertMany(dummyProducts);
      console.log(`[seed] Inserted ${inserted.length} dummy products.`);
    } else {
      console.log(
        `[seed] Database already has ${count} product(s) – skipping seed.`
      );
    }
  } catch (err) {
    console.error("[seed] Error seeding products:", err.message);
  }
}

module.exports = seedProducts;
