using System;
using System.Collections.Generic;
using UnityEngine;

namespace Muchi.Client
{
    [Serializable] sealed class LocaleTable
    {
        public string locale;
        public LocaleEntry[] entries;
    }

    [Serializable] sealed class LocaleEntry
    {
        public string key;
        public string value;
    }

    /// <summary>
    /// Runtime text tables. Add another Resources/Localization/{locale}.json table
    /// to add a language; English source strings are the per-key fallback.
    /// </summary>
    public static class LocaleService
    {
        const string PreferenceKey = "muchi.language";
        static readonly Dictionary<string, Dictionary<string, string>> Tables = LoadTables();
        static string current = LoadSavedLanguage();
        public static string Language => current;
        public static bool IsJapanese => current == "ja";
        public static Font UiFont { get; private set; }

        static Dictionary<string, Dictionary<string, string>> LoadTables()
        {
            var tables = new Dictionary<string, Dictionary<string, string>>();
            foreach (var asset in Resources.LoadAll<TextAsset>("Localization"))
            {
                var table = JsonUtility.FromJson<LocaleTable>(asset.text);
                if (table == null || string.IsNullOrEmpty(table.locale)) continue;
                var values = new Dictionary<string, string>();
                if (table.entries != null)
                    foreach (var entry in table.entries)
                        if (entry != null && !string.IsNullOrEmpty(entry.key))
                            values[entry.key] = entry.value;
                tables[table.locale] = values;
            }
            return tables;
        }

        static string LoadSavedLanguage()
        {
            var saved = PlayerPrefs.GetString(PreferenceKey, "ja");
            return Tables.ContainsKey(saved) ? saved : Tables.ContainsKey("ja") ? "ja" : "en";
        }

        static LocaleService()
        {
            UiFont = Resources.Load<Font>("Fonts/NotoSansCJKjp-Bold");
        }

        public static string Text(string source)
        {
            if (source == null || !Tables.TryGetValue(Language, out var table)) return source;
            return table.TryGetValue(source, out var translated) ? translated : source;
        }

        public static bool SetLanguage(string languageCode)
        {
            if (string.IsNullOrEmpty(languageCode) || !Tables.ContainsKey(languageCode)) return false;
            current = languageCode;
            PlayerPrefs.SetString(PreferenceKey, current);
            PlayerPrefs.Save();
            return true;
        }

        public static void Toggle()
        {
            var languages = new List<string>(Tables.Keys);
            languages.Sort(StringComparer.Ordinal);
            if (languages.Count < 2) return;
            var currentIndex = languages.IndexOf(Language);
            SetLanguage(languages[(currentIndex + 1) % languages.Count]);
        }
    }
}
