// Desktop wrapper.
//
// The app is a local HTTP server plus a browser UI, so the desktop build is thin: start the same
// server the CLI starts, on an OS-assigned port, and point a window at it. Nothing about the
// app's behaviour differs between `npm start` and the packaged build — only where presets are
// written, which has to be a per-user directory because the install directory is read-only.

import { app, BrowserWindow, Menu, dialog, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = 'https://github.com/ryangrams/atem-audio-presets'

// Must be set before the server module is imported — it reads this at load time.
process.env.ATEM_PRESET_DIR = path.join(app.getPath('userData'), 'presets')

let serverUrl = null
let stopServer = null

/** One instance only: two servers would mean two competing connections to the same switcher. */
if (!app.requestSingleInstanceLock()) {
	app.quit()
} else {
	app.on('second-instance', () => {
		const win = BrowserWindow.getAllWindows()[0]
		if (win) {
			if (win.isMinimized()) win.restore()
			win.focus()
		}
	})
}

function createWindow() {
	const win = new BrowserWindow({
		width: 1440,
		height: 940,
		minWidth: 1000,
		minHeight: 680,
		// Matches the UI's own background, so there is no white flash while it loads.
		backgroundColor: '#141414',
		title: 'ATEM Audio Presets',
		webPreferences: {
			// The page is our own local server and uses no Node APIs — keep it sandboxed.
			nodeIntegration: false,
			contextIsolation: true,
		},
	})
	win.loadURL(serverUrl)

	// Anything that isn't our own UI belongs in the user's browser, not in this window.
	win.webContents.setWindowOpenHandler(({ url }) => {
		shell.openExternal(url)
		return { action: 'deny' }
	})
	return win
}

function buildMenu() {
	const isMac = process.platform === 'darwin'
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			...(isMac ? [{ role: 'appMenu' }] : []),
			{ role: 'fileMenu' },
			// Without this, ⌘C / ⌘V do not work in the address and preset-name fields.
			{ role: 'editMenu' },
			{
				label: 'View',
				submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
			},
			{ role: 'windowMenu' },
			{
				role: 'help',
				submenu: [
					{ label: 'Project page', click: () => shell.openExternal(REPO) },
					{ label: 'Report an issue', click: () => shell.openExternal(`${REPO}/issues`) },
					{
						label: 'Show presets folder',
						click: () => shell.openPath(process.env.ATEM_PRESET_DIR),
					},
				],
			},
		])
	)
}

app.whenReady().then(async () => {
	try {
		const server = await import(path.join(__dirname, '..', 'server.js'))
		const { url } = await server.start({ port: 0 })
		serverUrl = url
		stopServer = server.stop
	} catch (e) {
		dialog.showErrorBox('ATEM Audio Presets could not start', String(e?.stack ?? e))
		app.quit()
		return
	}
	buildMenu()
	createWindow()

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow()
	})
})

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit()
})

// Drop the switcher connections politely — an ATEM only allows a handful at a time.
app.on('before-quit', async (e) => {
	if (!stopServer) return
	e.preventDefault()
	const stop = stopServer
	stopServer = null
	try {
		await stop()
	} finally {
		app.quit()
	}
})
