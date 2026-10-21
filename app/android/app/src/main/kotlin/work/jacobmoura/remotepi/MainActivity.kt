package work.jacobmoura.remotepi

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.provider.MediaStore
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // Plan 65 — hand-offs for files the agent sent to this phone.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "saveToDownloads" -> {
                        val path = call.argument<String>("path")
                        val name = call.argument<String>("name")
                        val mime = call.argument<String>("mime")
                        if (path == null || name == null) {
                            result.error("bad_args", "path and name are required", null)
                        } else {
                            saveToDownloads(path, name, mime, result)
                        }
                    }
                    "installApk" -> {
                        val path = call.argument<String>("path")
                        if (path == null) {
                            result.error("bad_args", "path is required", null)
                        } else {
                            installApk(path, result)
                        }
                    }
                    else -> result.notImplemented()
                }
            }
    }

    private fun receivedFile(path: String): File? {
        val root = File(filesDir, "received").canonicalFile
        val file = File(path).canonicalFile
        return if (file.isFile && file.path.startsWith(root.path + File.separator)) file else null
    }

    /** Copies the file into the public Downloads collection (MediaStore;
     *  no storage permission on API 29+). */
    private fun saveToDownloads(path: String, name: String, mime: String?, result: MethodChannel.Result) {
        val file = receivedFile(path)
        if (file == null) {
            result.error("not_found", "file not found", null)
            return
        }
        val resolver = contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime ?: "application/octet-stream")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        if (uri == null) {
            result.error("insert_failed", "MediaStore insert failed", null)
            return
        }
        try {
            resolver.openOutputStream(uri).use { out ->
                requireNotNull(out) { "no output stream" }
                file.inputStream().use { it.copyTo(out) }
            }
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            result.success(uri.toString())
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            result.error("write_failed", e.message, null)
        }
    }

    /** Opens Android's package installer for the APK. The system always
     *  asks the user (and for the "install unknown apps" permission). */
    private fun installApk(path: String, result: MethodChannel.Result) {
        val file = receivedFile(path)
        if (file == null) {
            result.error("not_found", "file not found", null)
            return
        }
        val uri = FileProvider.getUriForFile(this, "$packageName.receivedfiles", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, APK_MIME)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            startActivity(intent)
            result.success(null)
        } catch (e: ActivityNotFoundException) {
            result.error("no_installer", e.message, null)
        }
    }

    companion object {
        private const val CHANNEL = "remote_pi/files"
        private const val APK_MIME = "application/vnd.android.package-archive"
    }
}
