package io.github.aftab355.weightsync

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/* Background sync every few hours. Needs Health Connect's "access data in
 * the background" permission; without it the read is refused and the app
 * syncs only when opened. Failures are recorded for the screen to show, not
 * retried hard — the next run comes round anyway. */
class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val store = Store(applicationContext)
        if (!store.connected) return Result.success()
        try {
            store.lastMessage = SyncEngine(applicationContext).sync()
            store.lastOk = true
        } catch (e: SyncException) {
            store.lastMessage = e.message; store.lastOk = false
        } catch (e: SecurityException) {
            store.lastMessage = "Background reading isn't allowed, so it syncs when you open the app."
            store.lastOk = false
        } catch (e: Exception) {
            store.lastMessage = "Sync failed: ${e.message ?: e.javaClass.simpleName}"; store.lastOk = false
        }
        store.lastSyncAt = System.currentTimeMillis()
        return Result.success()
    }

    companion object {
        private const val NAME = "weight-sync"
        fun schedule(ctx: Context) {
            val req = PeriodicWorkRequestBuilder<SyncWorker>(3, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, req)
        }
        fun cancel(ctx: Context) = WorkManager.getInstance(ctx).cancelUniqueWork(NAME)
    }
}
