import { Link, useLocation } from "react-router-dom";
import {
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
} from "@clerk/clerk-react";
import { ShoppingCart, Store, Zap } from "lucide-react";

export default function Navbar() {
  const location = useLocation();

  return (
    <nav className="bg-brutal-yellow border-b-4 border-brutal-black sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
        {/* ─── Logo ─────────────────────────────────── */}
        <Link to="/" className="flex items-center gap-3 no-underline">
          <div className="bg-brutal-black p-2 border-3 border-brutal-black shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]">
            <Store className="w-6 h-6 text-brutal-yellow" />
          </div>
          <span className="text-2xl font-bold tracking-tight text-brutal-black uppercase">
            Brutal Store
          </span>
        </Link>

        {/* ─── Nav Links ────────────────────────────── */}
        <div className="flex items-center gap-4">
          <Link
            to="/"
            className={`
              px-4 py-2 font-bold uppercase text-sm border-3 border-brutal-black
              no-underline text-brutal-black
              shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]
              hover:translate-x-[2px] hover:translate-y-[2px]
              hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]
              transition-all duration-100
              ${location.pathname === "/" ? "bg-brutal-green" : "bg-white"}
            `}
          >
            <span className="flex items-center gap-1.5">
              <Zap className="w-4 h-4" />
              Catalog
            </span>
          </Link>

          <Link
            to="/cart"
            className={`
              px-4 py-2 font-bold uppercase text-sm border-3 border-brutal-black
              no-underline text-brutal-black
              shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]
              hover:translate-x-[2px] hover:translate-y-[2px]
              hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]
              transition-all duration-100
              ${location.pathname === "/cart" ? "bg-brutal-pink" : "bg-white"}
            `}
          >
            <span className="flex items-center gap-1.5">
              <ShoppingCart className="w-4 h-4" />
              Cart
            </span>
          </Link>

          {/* ─── Auth ──────────────────────────────── */}
          <SignedOut>
            <SignInButton mode="modal">
              <button
                className="
                  px-5 py-2 font-bold uppercase text-sm
                  bg-brutal-blue text-brutal-black
                  border-3 border-brutal-black
                  shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]
                  hover:translate-x-[2px] hover:translate-y-[2px]
                  hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]
                  transition-all duration-100 cursor-pointer
                "
              >
                Sign In
              </button>
            </SignInButton>
          </SignedOut>

          <SignedIn>
            <div className="border-3 border-brutal-black shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] rounded-full">
              <UserButton
                appearance={{
                  elements: {
                    avatarBox: "w-9 h-9",
                  },
                }}
              />
            </div>
          </SignedIn>
        </div>
      </div>
    </nav>
  );
}
