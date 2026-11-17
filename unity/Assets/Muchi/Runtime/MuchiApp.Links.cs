namespace Muchi.Client
{
    // U1 integration: links between the screen areas built in parallel (daily ↔ raising).
    public sealed partial class MuchiApp
    {
        // the horse card's 「調教する」 opens the daily stream's training screen for that horse
        partial void RaisingOpenTraining(string horseId, ref bool opened) { DailyTrainingFor(horseId); opened = true; }
    }
}
