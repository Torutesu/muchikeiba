using Muchi.Client;
using Muchi.Game;
using UnityEngine;

namespace Muchi.Unity
{
    /// <summary>PlayerPrefs-backed key/value store and analytics queue store (main thread only, like PlayerPrefs).</summary>
    public sealed class PlayerPrefsStore : IKeyValueStore, IAnalyticsStore
    {
        public const string AnalyticsKey = "muchi.analytics.queue";

        public string Get(string key) => PlayerPrefs.HasKey(key) ? PlayerPrefs.GetString(key) : null;

        public void Set(string key, string value)
        {
            PlayerPrefs.SetString(key, value ?? "");
            PlayerPrefs.Save();
        }

        string IAnalyticsStore.Load() => Get(AnalyticsKey);
        void IAnalyticsStore.Save(string json) => Set(AnalyticsKey, json);
    }
}
