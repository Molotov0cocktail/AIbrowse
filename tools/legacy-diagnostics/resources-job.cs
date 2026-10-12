using System;
using System.Threading;

namespace AIbrowse.LegacyResources
{
    public sealed class JobWorker
    {
        public Thread Thread;
        public AIbrowse.Performance.PerformanceJob.Result Result;
        public Exception Error;
        public JobWorker(string executable, string entry, string scope, string runId, int budgetMs)
        {
            Thread = new Thread(() => {
                try { Result = AIbrowse.Performance.PerformanceJob.Execute("performance", executable, entry, scope, scope, runId, budgetMs); }
                catch (Exception error) { Error = error; }
            });
            Thread.IsBackground = true;
            Thread.Start();
        }
    }
}
