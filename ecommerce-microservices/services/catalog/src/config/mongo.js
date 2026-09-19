/**
 * MongoDB Connection
 *
 * Connects Mongoose to the catalog database specified in CATALOG_MONGO_URI.
 */

const mongoose = require("mongoose");

async function connectMongo() {
  const uri = process.env.CATALOG_MONGO_URI;

  if (!uri) {
    throw new Error("CATALOG_MONGO_URI is not defined in the root .env");
  }

  await mongoose.connect(uri);
  console.log("[db] Connected to MongoDB (catalog_db)");
}

module.exports = connectMongo;
