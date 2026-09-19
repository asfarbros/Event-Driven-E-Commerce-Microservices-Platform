import { Routes, Route } from "react-router-dom";
import Navbar from "./components/Navbar";
import CatalogPage from "./pages/CatalogPage";
import CartPage from "./pages/CartPage";

export default function App() {
  return (
    <div className="min-h-screen bg-brutal-bg">
      <Navbar />
      <main className="max-w-7xl mx-auto px-6 py-8">
        <Routes>
          <Route path="/" element={<CatalogPage />} />
          <Route path="/cart" element={<CartPage />} />
        </Routes>
      </main>
    </div>
  );
}
