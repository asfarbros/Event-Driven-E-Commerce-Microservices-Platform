/**
 * MongoDB Connection
 *
 * Connects Mongoose to the MongoDB instance specified in MONGO_URI.
 */

const mongoose = require("mongoose");

async function connectMongo() {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    throw new Error("MONGO_URI is not defined in .env");
  }

  await mongoose.connect(uri);
  console.log("[db] Connected to MongoDB");
}

module.exports = connectMongo;
