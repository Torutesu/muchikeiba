using System.Collections.Generic;
using Muchi.Client;

namespace Muchi.Game
{
    /// <summary>
    /// REQ-UXU-016: server error code → one Japanese sentence (the club prototype's ERROR_TEXT is the reference, plus the
    /// round 8 codes). Screens show <see cref="For"/> instead of the raw "CODE / message" form. Codes not in the table
    /// fall back to "通信に失敗しました（CODE）" with a retry.
    /// REQ-L10N-010: the Japanese here is the source; <see cref="For"/> and <see cref="Reward"/> return the app's language
    /// (Loc.T with Resources/Muchi/ui-en.json). Model properties stay Japanese: screens show <c>Loc.T(model.X)</c>.
    /// </summary>
    public static class UxText
    {
        public const string Offline = "オフラインです。練習レースは遊べます";
        public const string Retry = "再試行";
        public const string NotPurchased = "購入は完了していません";
        public const string PurchasePending = "確認中。付与されたらお知らせします";

        public static readonly IReadOnlyDictionary<string, string> Errors = new Dictionary<string, string>
        {
            ["INVALID_NAME"] = "カタカナ2〜9文字で入力してください（ひらがなは自動でカタカナになります）。",
            ["NG_NAME"] = "この名前は使用できません。別の名前を入力してください。",
            ["AGE_REQUIRED"] = "生年月を入力してください。",
            ["AGE_LIMIT_EXCEEDED"] = "今月の購入上限に達しています。翌月1日に戻ります。",
            ["GUARDIAN_CONSENT_REQUIRED"] = "18歳未満の方は保護者の同意が必要です。",
            ["ALREADY_PURCHASED"] = "この商品は購入済みです。",
            ["UNSETTLED_DEBT"] = "未精算の返金があるため、購入・スカウトを止めています。お問い合わせください。",
            ["ALREADY_CLAIMED"] = "受取済みです。",
            ["NOT_ELIGIBLE"] = "まだ条件を満たしていません。",
            ["INSUFFICIENT_COINS"] = "コインが足りません。",
            ["INSUFFICIENT_ITEMS"] = "アイテムが足りません。",
            ["TUTORIAL_GACHA_USED"] = "入厩祝いのスカウトは受け取り済みです。",
            ["CONSENT_VERSION_MISMATCH"] = "規約が更新されました。もう一度ご確認ください。",
            ["PARTNER_ALREADY_GRANTED"] = "最初の相棒はすでに迎えています。",
            ["DELETION_CONFIRM_INVALID"] = "確認の期限が切れました。もう一度はじめからお進みください。",
            ["DELETION_PENDING"] = "アカウント削除の予定があります。取り消すと使えます。",
            ["LIKE_LIMIT"] = "今日のいいねを使い切りました。",
            ["ALREADY_LIKED"] = "今日はこの厩舎にいいね済みです。",
            ["ALREADY_IN_RACE"] = "前のレースが続いています。",
            ["RATE_LIMITED"] = "混み合っています。少し待ってからお試しください。",
            ["TRAINING_LIMIT"] = "今日の調教はおしまいです。4:00に戻ります。",
            ["TRAINING_TIRED"] = "疲れがたまっています。プールか、1日休ませましょう。",
            ["TRAINING_POTENTIAL_FULL"] = "この馬は素質いっぱいまで伸びました。",
            ["TRAINING_SESSION_EXPIRED"] = "時間切れのため、ミニゲームなしで記録しました。",
            ["TRAINING_INPUT_INVALID"] = "入力を確認できませんでした。もう一度お試しください。",
            ["GIFT_EXPIRED"] = "このプレゼントは受け取り期限を過ぎました。",
            ["GIFT_HOLD_CAP"] = "持てる上限に達しているため、受け取れません。",
            ["RIVAL_CHALLENGE_LIMIT"] = "今日の挑戦状は送り切りました。4:00に戻ります。",
            ["EXCHANGE_NOT_OPEN"] = "交換所はまだ開いていません。",
            ["EXCHANGE_CLOSED"] = "交換所は終了しました。残りのポイントは配合素材になります。",
            ["OUT_OF_STOCK"] = "この交換は上限まで交換済みです。",
            ["INSUFFICIENT_POINTS"] = "イベントポイントが足りません。",
            ["NETWORK"] = Offline,
        };

        /// <summary>The sentence for a failure (never the raw code alone).</summary>
        public static string For(ApiException e)
        {
            if (e == null) return null;
            if (e is NetworkException) return Loc.T(Offline);
            return Loc.T(Errors.TryGetValue(e.WireCode ?? "", out var t) ? t : "通信に失敗しました（" + e.WireCode + "）");
        }

        /// <summary>A reward as one line ("無償コイン50枚" / "繁殖牝馬1頭" / "パスXP 100" / "gacha_ticket ×1"). Item names come from the item catalog when the screen has it.</summary>
        public static string Reward(Muchi.Client.Reward r, System.Func<string, string> itemName = null)
        {
            if (r == null) return "";
            var parts = new List<string>();
            if (r.FreeCoins > 0) parts.Add("無償コイン" + r.FreeCoins + "枚");
            foreach (var it in r.Items) parts.Add((itemName?.Invoke(it.ItemId) ?? it.ItemId) + "×" + it.Qty);
            if (r.Broodmare != null) parts.Add("繁殖牝馬1頭");
            if (r.Horse != null) parts.Add("馬1頭");
            if (r.PassXp > 0) parts.Add("パスXP " + r.PassXp);
            return Loc.T(string.Join("・", parts));
        }
    }
}
