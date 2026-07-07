import { createContext, use, type PropsWithChildren } from "react";
import { useLocalStorage } from "usehooks-ts";

import { type Locale, baseLocale } from "@/paraglide/runtime";

const LANGUAGE_KEY = "language";

const LanguageContext = createContext<{
  language: Locale;
  setLanguage: (language: Locale) => void;
} | null>(null);

export const useLanguage = () => {
  const context = use(LanguageContext);

  if (!context) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }

  return context;
};

export function LanguageProvider({ children }: PropsWithChildren) {
  const [language, setLanguage] = useLocalStorage<Locale>(
    LANGUAGE_KEY,
    baseLocale,
  );

  return (
    <LanguageContext.Provider
      value={{
        language,
        setLanguage,
      }}
    >
      {children}
    </LanguageContext.Provider>
  );
}
