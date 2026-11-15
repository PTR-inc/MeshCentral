/*
 * @description Cross-platform macOS flat package builder for MeshAgent installers.
 * Creates a XAR-based distribution package instead of the legacy bundle .mpkg
 * format that macOS Sequoia/Tahoe rejects.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const childProcess = require('child_process');
const { promisify } = require('util');

const deflate = promisify(zlib.deflate);
const execFile = promisify(childProcess.execFile);

const LAUNCH_DAEMON_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>###SERVICENAME###</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/mesh_services/###COMPANYNAME###/###SERVICENAME###/###EXECUTABLENAME###</string>
      <string>--meshServiceName="###SERVICENAME###"</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/usr/local/mesh_services/###COMPANYNAME###/###SERVICENAME###/</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
  </dict>
</plist>
`;

const LAUNCH_AGENT_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>###SERVICENAME###-launchagent</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/mesh_services/###COMPANYNAME###/###SERVICENAME###/###EXECUTABLENAME###</string>
      <string>-kvmagent</string>
    </array>
    <key>LimitLoadToSessionType</key>
    <array>
      <string>LoginWindow</string>
      <string>Aqua</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/usr/local/mesh_services/###COMPANYNAME###/###SERVICENAME###/</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
  </dict>
</plist>
`;

// Users with a loginwindow process have a GUI session, the LaunchAgent is loaded into each of them
const GUI_UIDS = `gui_uids() { /bin/ps -axo uid=,comm= | /usr/bin/awk '$2 ~ /loginwindow$/ && $1 != 0 { print $1 }' | /usr/bin/sort -u; }
`;

// An upgrade replaces the binary, so the running daemon and every session's KVM agent are stopped first
const PREINSTALL = `#!/bin/bash
` + GUI_UIDS + `
SERVICENAME="###SERVICENAME###"
if [ -f "/Library/LaunchDaemons/\${SERVICENAME}.plist" ]; then
    /bin/launchctl bootout system "/Library/LaunchDaemons/\${SERVICENAME}.plist" >/dev/null 2>&1 || true
fi
if [ -f "/Library/LaunchAgents/\${SERVICENAME}-launchagent.plist" ]; then
    for GUI_UID in $(gui_uids); do
        /bin/launchctl bootout "gui/\${GUI_UID}" "/Library/LaunchAgents/\${SERVICENAME}-launchagent.plist" >/dev/null 2>&1 || true
    done
fi
exit 0
`;

const POSTINSTALL = `#!/bin/bash
set -e
` + GUI_UIDS + `
SERVICENAME="###SERVICENAME###"
COMPANYNAME="###COMPANYNAME###"
EXECUTABLENAME="###EXECUTABLENAME###"
INSTALLDIR="/usr/local/mesh_services/\${COMPANYNAME}/\${SERVICENAME}"

chown -R root:wheel "/usr/local/mesh_services/\${COMPANYNAME}" || true
chown root:wheel "\${INSTALLDIR}/\${EXECUTABLENAME}" "\${INSTALLDIR}/\${EXECUTABLENAME}.msh"
chown root:wheel "/Library/LaunchDaemons/\${SERVICENAME}.plist" "/Library/LaunchAgents/\${SERVICENAME}-launchagent.plist"

chmod 755 "\${INSTALLDIR}" "\${INSTALLDIR}/\${EXECUTABLENAME}"
chmod 644 "\${INSTALLDIR}/\${EXECUTABLENAME}.msh" "/Library/LaunchDaemons/\${SERVICENAME}.plist" "/Library/LaunchAgents/\${SERVICENAME}-launchagent.plist"

/bin/launchctl bootout system "/Library/LaunchDaemons/\${SERVICENAME}.plist" >/dev/null 2>&1 || true
/bin/launchctl bootstrap system "/Library/LaunchDaemons/\${SERVICENAME}.plist" >/dev/null 2>&1 || /bin/launchctl load "/Library/LaunchDaemons/\${SERVICENAME}.plist"

for GUI_UID in $(gui_uids); do
    /bin/launchctl bootout "gui/\${GUI_UID}" "/Library/LaunchAgents/\${SERVICENAME}-launchagent.plist" >/dev/null 2>&1 || true
    /bin/launchctl bootstrap "gui/\${GUI_UID}" "/Library/LaunchAgents/\${SERVICENAME}-launchagent.plist" >/dev/null 2>&1 || true
done

# Copied here instead of shipped in the payload, because Installer would give an existing /Applications the payload's owner and mode.
# The app hands its script to root, so it must be root-owned.
if [ -d "\${INSTALLDIR}/Uninstall.app" ]; then
    rm -rf ###UNINSTALLAPP### && mkdir -p ###UNINSTALLDIR### && ditto "\${INSTALLDIR}/Uninstall.app" ###UNINSTALLAPP### && chown -R root:wheel ###UNINSTALLAPP### || true
fi
`;

const UNINSTALL = `#!/bin/bash
` + GUI_UIDS + `
echo "Stopping ###SERVICENAME###..."
sudo /bin/launchctl bootout system "/Library/LaunchDaemons/###SERVICENAME###.plist" &> /dev/null || sudo /bin/launchctl unload "/Library/LaunchDaemons/###SERVICENAME###.plist" &> /dev/null
for GUI_UID in $(gui_uids); do
    sudo /bin/launchctl bootout "gui/\${GUI_UID}" "/Library/LaunchAgents/###SERVICENAME###-launchagent.plist" &> /dev/null || true
done
# The full path also matches when the binary name differs from the service name
sudo pkill -9 -f "^/usr/local/mesh_services/###COMPANYNAME###/###SERVICENAME###/###EXECUTABLENAME###( |$)" &> /dev/null || true
sudo /bin/launchctl unload "/Library/LaunchDaemons/meshagentDiagnostic_periodicStart.plist" &> /dev/null
sudo /bin/launchctl unload "/Library/LaunchDaemons/meshagentDiagnostic.plist" &> /dev/null
sudo rm "/Library/LaunchDaemons/meshagentDiagnostic_periodicStart.plist" &> /dev/null
sudo rm "/Library/LaunchDaemons/meshagentDiagnostic.plist" &> /dev/null

echo "Resetting TCC permissions for ###SERVICENAME###..."
BUNDLE_ID=$(mdls -name kMDItemCFBundleIdentifier -raw "/usr/local/mesh_services/###COMPANYNAME###/###SERVICENAME###/###EXECUTABLENAME###" 2>/dev/null || true)
if [ -n "\${BUNDLE_ID}" ] && [ "\${BUNDLE_ID}" != "(null)" ]; then
    sudo tccutil reset All "\${BUNDLE_ID}" &> /dev/null || true
fi
sudo tccutil reset All "###SERVICENAME###" &> /dev/null || true

# The service folder also holds the log, the DAIPC socket and the rotated logs.
# It is only removed when it holds this agent's binary, so an empty name can never remove the folder of every service.
INSTALLDIR="/usr/local/mesh_services/###COMPANYNAME###/###SERVICENAME###"
if [ -n "###SERVICENAME###" ] && [ -f "\${INSTALLDIR}/###EXECUTABLENAME###" ]; then
    sudo rm -rf "\${INSTALLDIR}" &> /dev/null
fi
sudo rmdir "/usr/local/mesh_services/###COMPANYNAME###" &> /dev/null
sudo rm "/usr/local/mesh_services/meshagentDiagnostic/meshagentDiagnostic" &> /dev/null
sudo rm "/Library/LaunchDaemons/###SERVICENAME###.plist" &> /dev/null
sudo rm "/Library/LaunchAgents/###SERVICENAME###-launchagent.plist" &> /dev/null
# The KVM agents leave one socket per user, only names that end in a uid are removed so another service's sockets stay
for SOCK in /tmp/meshagent-kvm-###SERVICENAME###-*.sock; do
    SOCKUID="\${SOCK#/tmp/meshagent-kvm-###SERVICENAME###-}"
    SOCKUID="\${SOCKUID%.sock}"
    case "\${SOCKUID}" in
        ''|*[!0-9]*) ;;
        *) sudo rm -f "\${SOCK}" &> /dev/null ;;
    esac
done
sudo pkgutil --forget "###PKGID###" &> /dev/null
sudo rm -rf ###UNINSTALLAPP### &> /dev/null
sudo rmdir ###UNINSTALLDIR### &> /dev/null
echo "###SERVICENAME### was uninstalled."
`;

// Names reach AppleScript as arguments, so quotes in them cannot break the uninstall app's dialogs
const UNINSTALL_APP_LAUNCHER = `#!/bin/bash
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
NAME=###DISPLAYNAMEQ###
EXE=###EXECUTABLENAMEQ###

/usr/bin/osascript - "Remove \${NAME} from this computer?" "\${NAME}" <<'EOF' >/dev/null || exit 0
on run argv
    activate
    display dialog (item 1 of argv) with title (item 2 of argv) buttons {"Cancel", "Remove"} default button "Remove" cancel button "Cancel" with icon caution
end run
EOF

# TCC records a bare executable by path and tccutil only resets bundle IDs, so the user removes the grants by hand
pane() {
    /usr/bin/open "x-apple.systempreferences:com.apple.preference.security?$1"
    /usr/bin/osascript - "In the list that just opened, select \\"\${EXE}\\" and click the minus button. Then click Next." "\${NAME}: $2" <<'EOF'
on run argv
    activate
    button returned of (display dialog (item 1 of argv) with title (item 2 of argv) buttons {"Skip the rest", "Next"} default button "Next")
end run
EOF
}
SKIPPED=1
if [ "$(pane Privacy_ScreenCapture 'Screen Recording')" = "Next" ] && [ "$(pane Privacy_Accessibility 'Accessibility')" = "Next" ] && [ "$(pane Privacy_AllFiles 'Full Disk Access')" = "Next" ]; then
    SKIPPED=0
fi
/usr/bin/osascript -e 'tell application "System Settings" to quit' >/dev/null 2>&1

# The app is root-owned in /Applications, so the script runs in place and bash keeps it open while the script deletes the app
OUT=$(/usr/bin/osascript - "\${RES}/uninstall.sh" "Enter your password to remove \${NAME}." <<'EOF' 2>&1
on run argv
    do shell script "/bin/bash " & quoted form of (item 1 of argv) & " 2>&1" with prompt (item 2 of argv) with administrator privileges
end run
EOF
)
RC=$?
case "\${OUT}" in *"(-128)"*) exit 0 ;; esac

if [ \${RC} -eq 0 ]; then MSG="\${NAME} was removed."; [ \${SKIPPED} -eq 1 ] && MSG="\${MSG} Remaining permissions can be removed in System Settings, Privacy & Security."; else MSG="Removing \${NAME} failed: $(printf '%s' "\${OUT}" | tail -3)"; fi
/usr/bin/osascript - "\${MSG}" "\${NAME}" <<'EOF' >/dev/null
on run argv
    activate
    display dialog (item 1 of argv) with title (item 2 of argv) buttons {"OK"} default button "OK"
end run
EOF
exit 0
`;

// LaunchServices cannot tell the architecture of a script executable and asks for Rosetta on Apple silicon without the two LS keys
const UNINSTALL_APP_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleExecutable</key><string>uninstall</string>
    <key>CFBundleIdentifier</key><string>###UNINSTALLAPPID###</string>
    <key>CFBundleName</key><string>###UNINSTALLAPPNAMEX###</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>LSUIElement</key><true/>
    <key>LSArchitecturePriority</key><array><string>arm64</string><string>x86_64</string></array>
    <key>LSRequiresNativeExecution</key><true/>
  </dict>
</plist>
`;

function replaceTokens(str, tokens) {
    return str.split('###SERVICENAME###').join(tokens.serviceName)
        .split('###COMPANYNAME###').join(tokens.companyName)
        .split('###EXECUTABLENAME###').join(tokens.executableName)
        .split('###PKGID###').join(tokens.pkgId)
        .split('###UNINSTALLDIR###').join(shellQuote(tokens.uninstallDir))
        .split('###UNINSTALLAPP###').join(shellQuote(tokens.uninstallDir + '/' + tokens.uninstallName))
        .split('###UNINSTALLAPPID###').join(xmlEscape(tokens.pkgId.replace(/\.pkg$/, '.uninstall')))
        .split('###UNINSTALLAPPNAMEX###').join(xmlEscape(tokens.uninstallName.replace(/\.app$/, '')))
        .split('###DISPLAYNAMEQ###').join(shellQuote(tokens.displayName))
        .split('###EXECUTABLENAMEQ###').join(shellQuote(tokens.executableName));
}

function shellQuote(str) {
    return "'" + String(str).split("'").join("'\\''") + "'";
}

function xmlEscape(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function pkgIdentifierSegment(str) {
    return String(str).toLowerCase().replace(/[^a-z0-9.-]/g, '-').replace(/^-+|-+$/g, '') || 'meshagent';
}

async function chmodIfExists(file, mode) {
    try { await fsp.chmod(file, mode); } catch (ex) { }
}

async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    let files = 0, bytes = 0;
    for (const entry of entries) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const r = await walk(p);
            files += r.files;
            bytes += r.bytes;
        } else if (entry.isFile()) {
            const s = await fsp.stat(p);
            files++;
            bytes += s.size;
        }
    }
    return { files, bytes };
}

function pad4(buffer) {
    const pad = (4 - (buffer.length % 4)) % 4;
    return (pad === 0) ? buffer : Buffer.concat([buffer, Buffer.alloc(pad)]);
}

function octal(value, width) {
    const max = Math.pow(8, width) - 1;
    const n = Math.max(0, Math.min(Number(value) || 0, max));
    return Math.floor(n).toString(8).padStart(width, '0').slice(-width);
}

async function collectPayloadEntries(root, relativePath) {
    const fullPath = path.join(root, relativePath);
    const stat = await fsp.stat(fullPath);
    const entries = [];
    if (relativePath !== '') {
        entries.push({ name: relativePath.split(path.sep).join('/'), stat: stat, data: stat.isFile() ? await fsp.readFile(fullPath) : null });
    }
    if (stat.isDirectory()) {
        const names = (await fsp.readdir(fullPath)).sort();
        for (const name of names) { entries.push.apply(entries, await collectPayloadEntries(root, path.join(relativePath, name))); }
    }
    return entries;
}

function cpioOdcRecord(name, mode, data, ino, mtime) {
    data = data || Buffer.alloc(0);
    const nameBuffer = Buffer.from(name + '\0', 'utf8');
    const header = [
        '070707',
        octal(0, 6), // dev
        octal(ino, 6),
        octal(mode, 6),
        octal(0, 6), // uid
        octal(0, 6), // gid
        octal(1, 6), // nlink
        octal(0, 6), // rdev
        octal(mtime || Math.floor(Date.now() / 1000), 11),
        octal(nameBuffer.length, 6),
        octal(data.length, 11)
    ].join('');
    return Buffer.concat([Buffer.from(header, 'ascii'), nameBuffer, data]);
}

async function createPayload(payloadRoot, targetFile) {
    const entries = await collectPayloadEntries(payloadRoot, '');
    const records = [];
    let ino = 1;
    for (const entry of entries) {
        records.push(cpioOdcRecord(entry.name, entry.stat.mode, entry.data, ino++, Math.floor(entry.stat.mtimeMs / 1000)));
    }
    records.push(cpioOdcRecord('TRAILER!!!', 0, Buffer.alloc(0), ino));
    await fsp.writeFile(targetFile, zlib.gzipSync(Buffer.concat(records)));
}

async function createBom(payloadRoot, targetFile) {
    try {
        await execFile('mkbom', [payloadRoot, targetFile], { timeout: 30000 });
    } catch (ex) {
        // Linux/Windows hosts can still build the package archive without a
        // third-party BOM dependency. macOS hosts use the native mkbom tool
        // above so local validation keeps the richer bill of materials.
        await fsp.writeFile(targetFile, Buffer.alloc(0));
    }
}

async function collectXarEntry(filePath, name, id) {
    const stat = await fsp.stat(filePath);
    const entry = {
        id: id,
        name: name,
        type: stat.isDirectory() ? 'directory' : 'file',
        mode: stat.mode,
        uid: stat.uid,
        gid: stat.gid,
        atime: stat.atime,
        mtime: stat.mtime,
        ctime: stat.ctime
    };
    if (stat.isFile()) {
        entry.data = await fsp.readFile(filePath);
    } else if (stat.isDirectory()) {
        const names = (await fsp.readdir(filePath)).sort();
        entry.children = [];
        for (const childName of names) {
            entry.children.push(await collectXarEntry(path.join(filePath, childName), childName, ++collectXarEntry.nextId));
        }
    }
    return entry;
}

function xarDate(d) {
    return d.toISOString();
}

function xarFileXml(entry, depth, heapParts) {
    const indent = ' '.repeat(depth);
    let xml = indent + '<file id="' + entry.id + '">\n'
        + indent + ' <name>' + xmlEscape(entry.name) + '</name>\n'
        + indent + ' <type>' + entry.type + '</type>\n'
        + indent + ' <mode>' + entry.mode.toString(8) + '</mode>\n'
        + indent + ' <uid>' + entry.uid + '</uid>\n'
        + indent + ' <gid>' + entry.gid + '</gid>\n'
        + indent + ' <atime>' + xarDate(entry.atime) + '</atime>\n'
        + indent + ' <mtime>' + xarDate(entry.mtime) + '</mtime>\n'
        + indent + ' <ctime>' + xarDate(entry.ctime) + '</ctime>\n';
    if (entry.type == 'file') {
        const offset = 20 + heapParts.reduce(function (total, part) { return total + part.length; }, 0);
        const sum = crypto.createHash('sha1').update(entry.data).digest('hex');
        heapParts.push(entry.data);
        xml += indent + ' <data>\n'
            + indent + '  <archived-checksum style="sha1">' + sum + '</archived-checksum>\n'
            + indent + '  <extracted-checksum style="sha1">' + sum + '</extracted-checksum>\n'
            + indent + '  <offset>' + offset + '</offset>\n'
            + indent + '  <encoding style="application/octet-stream"/>\n'
            + indent + '  <size>' + entry.data.length + '</size>\n'
            + indent + '  <length>' + entry.data.length + '</length>\n'
            + indent + ' </data>\n';
    } else {
        for (const child of entry.children) { xml += xarFileXml(child, depth + 1, heapParts); }
    }
    return xml + indent + '</file>\n';
}

async function createXarPackage(paths) {
    collectXarEntry.nextId = 0;
    const entries = [];
    for (const p of paths) { entries.push(await collectXarEntry(p, path.basename(p), ++collectXarEntry.nextId)); }

    const heapParts = [];
    let toc = '<?xml version="1.0" encoding="UTF-8"?>\n<xar>\n <toc>\n'
        + '  <checksum style="sha1">\n   <size>20</size>\n   <offset>0</offset>\n  </checksum>\n'
        + '  <creation-time>' + (new Date()).toISOString() + '</creation-time>\n';
    for (const entry of entries) { toc += xarFileXml(entry, 2, heapParts); }
    toc += ' </toc>\n</xar>';

    const tocBuffer = Buffer.from(toc, 'utf8');
    const compressedToc = await deflate(tocBuffer);
    const tocChecksum = crypto.createHash('sha1').update(compressedToc).digest();
    const header = Buffer.alloc(28);
    header.writeUInt32BE(0x78617221, 0); // xar!
    header.writeUInt16BE(28, 4);
    header.writeUInt16BE(1, 6);
    header.writeBigUInt64BE(BigInt(compressedToc.length), 8);
    header.writeBigUInt64BE(BigInt(tocBuffer.length), 16);
    header.writeUInt32BE(1, 24); // sha1
    return Buffer.concat([header, compressedToc, tocChecksum].concat(heapParts));
}

// Without p.payloadRoot this builds a payload-free package that only runs its scripts
async function buildFlatPackage(tmpRoot, p) {
    const basePkg = path.join(tmpRoot, 'internal.pkg');
    const resourcesDir = path.join(tmpRoot, 'Resources');
    await fsp.mkdir(basePkg, { recursive: true });
    await fsp.mkdir(resourcesDir, { recursive: true });

    await fsp.copyFile(p.backgroundPath || path.join(__dirname, 'agents', 'macosinstallerbackground.png'), path.join(resourcesDir, 'background'));

    let installKBytes = 0, payloadXml = '';
    if (p.payloadRoot) {
        const payloadStats = await walk(p.payloadRoot);
        installKBytes = Math.ceil(payloadStats.bytes / 1000);
        await createPayload(p.payloadRoot, path.join(basePkg, 'Payload'));
        await createBom(p.payloadRoot, path.join(basePkg, 'Bom'));
        payloadXml = '  <payload installKBytes="' + installKBytes + '" numberOfFiles="' + payloadStats.files + '"/>\n';
    }

    let scriptsXml = '';
    for (const name of ['preinstall', 'postinstall']) {
        if (fs.existsSync(path.join(p.scriptsRoot, name))) {
            await chmodIfExists(path.join(p.scriptsRoot, name), 0o755);
            scriptsXml += '    <' + name + ' file="./' + name + '"/>\n';
        }
    }
    await createPayload(p.scriptsRoot, path.join(basePkg, 'Scripts'));

    const packageInfo = '<pkg-info format-version="2" identifier="' + xmlEscape(p.identifier) + '" version="1.0" install-location="/" relocatable="false" auth="root">\n'
        + payloadXml
        + '  <scripts>\n'
        + scriptsXml
        + '  </scripts>\n'
        + '</pkg-info>\n';
    await fsp.writeFile(path.join(basePkg, 'PackageInfo'), packageInfo);

    const distribution = '<?xml version="1.0" encoding="utf-8"?>\n'
        + '<installer-script minSpecVersion="1.000000">\n'
        + '    <title>' + xmlEscape(p.title) + '</title>\n'
        + '    <options customize="always" allow-external-scripts="no" rootVolumeOnly="true"/>\n'
        + '    <background file="background" alignment="topleft" scaling="tofit"/>\n'
        + '    <welcome language="en-US" mime-type="text/plain"><![CDATA[' + p.welcome.split(']]>').join(']]]]><![CDATA[>') + ']]></welcome>\n'
        + '    <choices-outline>\n'
        + '        <line choice="choice65"/>\n'
        + '    </choices-outline>\n'
        + '    <choice id="choice65" title="' + xmlEscape(p.title) + '">\n'
        + '        <pkg-ref id="internal.pkg"/>\n'
        + '    </choice>\n'
        + '    <pkg-ref id="internal.pkg" installKBytes="' + installKBytes + '" version="1.0" auth="Root">#internal.pkg</pkg-ref>\n'
        + '    <options hostArchitectures="arm64,x86_64"/>\n'
        + '</installer-script>\n';
    await fsp.writeFile(path.join(tmpRoot, 'Distribution'), distribution);

    return createXarPackage([basePkg, resourcesDir, path.join(tmpRoot, 'Distribution')]);
}

async function writeUninstallApp(appDir, tokens) {
    const contents = path.join(appDir, 'Contents');
    await fsp.mkdir(path.join(contents, 'MacOS'), { recursive: true });
    await fsp.mkdir(path.join(contents, 'Resources'), { recursive: true });
    await fsp.writeFile(path.join(contents, 'Info.plist'), replaceTokens(UNINSTALL_APP_PLIST, tokens));
    await fsp.writeFile(path.join(contents, 'MacOS', 'uninstall'), replaceTokens(UNINSTALL_APP_LAUNCHER, tokens));
    await fsp.writeFile(path.join(contents, 'Resources', 'uninstall.sh'), replaceTokens(UNINSTALL, tokens).split('sudo ').join(''));
    await chmodIfExists(path.join(contents, 'Info.plist'), 0o644);
    await chmodIfExists(path.join(contents, 'MacOS', 'uninstall'), 0o755);
    await chmodIfExists(path.join(contents, 'Resources', 'uninstall.sh'), 0o644);
}

async function createMacOSInstaller(opts) {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'meshcentral-macos-pkg-'));
    try {
        const pkgIdSegment = pkgIdentifierSegment(opts.serviceName);
        const pkgId = 'com.meshcentral.' + pkgIdSegment + '.pkg';
        const tokens = {
            serviceName: opts.serviceName, companyName: opts.companyName, executableName: opts.executableName, pkgId: pkgId, displayName: opts.displayName,
            uninstallDir: '/Applications/' + String(opts.displayName).split('/').join('-'),
            uninstallName: 'Uninstall ' + String(opts.serviceName).split('/').join('-') + '.app'
        };

        // The uninstaller runs the Uninstall.command steps as root from Installer, so sudo is dropped
        const uninstallRoot = path.join(tmpRoot, 'uninstall');
        const uninstallScripts = path.join(uninstallRoot, 'scripts');
        await fsp.mkdir(uninstallScripts, { recursive: true });
        await fsp.writeFile(path.join(uninstallScripts, 'postinstall'), replaceTokens(UNINSTALL, tokens).split('sudo ').join(''));
        const uninstallPkg = await buildFlatPackage(uninstallRoot, {
            scriptsRoot: uninstallScripts,
            identifier: 'com.meshcentral.' + pkgIdSegment + '.uninstall.pkg',
            title: 'Uninstall ' + opts.displayName,
            welcome: 'This will remove the mesh agent "' + opts.serviceName + '" from this computer.\n',
            backgroundPath: opts.backgroundPath
        });

        const installRoot = path.join(tmpRoot, 'install');
        const payloadRoot = path.join(installRoot, 'payload');
        const scriptsRoot = path.join(installRoot, 'scripts');
        const installDir = path.join(payloadRoot, 'usr', 'local', 'mesh_services', opts.companyName, opts.serviceName);
        const launchDaemons = path.join(payloadRoot, 'Library', 'LaunchDaemons');
        const launchAgents = path.join(payloadRoot, 'Library', 'LaunchAgents');

        await fsp.mkdir(installDir, { recursive: true });
        await fsp.mkdir(launchDaemons, { recursive: true });
        await fsp.mkdir(launchAgents, { recursive: true });
        await fsp.mkdir(scriptsRoot, { recursive: true });

        await fsp.copyFile(opts.agentPath, path.join(installDir, opts.executableName));
        await fsp.writeFile(path.join(installDir, opts.executableName + '.msh'), opts.meshSettings);
        await writeUninstallApp(path.join(installDir, 'Uninstall.app'), tokens);
        await fsp.writeFile(path.join(launchDaemons, opts.serviceName + '.plist'), replaceTokens(LAUNCH_DAEMON_PLIST, tokens));
        await fsp.writeFile(path.join(launchAgents, opts.serviceName + '-launchagent.plist'), replaceTokens(LAUNCH_AGENT_PLIST, tokens));
        await fsp.writeFile(path.join(scriptsRoot, 'preinstall'), replaceTokens(PREINSTALL, tokens));
        await fsp.writeFile(path.join(scriptsRoot, 'postinstall'), replaceTokens(POSTINSTALL, tokens));

        await chmodIfExists(path.join(installDir, opts.executableName), 0o755);
        await chmodIfExists(path.join(installDir, opts.executableName + '.msh'), 0o644);
        await chmodIfExists(path.join(launchDaemons, opts.serviceName + '.plist'), 0o644);
        await chmodIfExists(path.join(launchAgents, opts.serviceName + '-launchagent.plist'), 0o644);

        const welcome = 'Welcome to the MeshCentral agent for MacOS\n\nThis installer will install the mesh agent for "' + opts.meshName + '" and allow the administrator to remotely monitor and control this computer over the internet. For more information, go to https://meshcentral.com.\n\nThis software is provided under Apache 2.0 license.\n';
        const pkgBuffer = await buildFlatPackage(installRoot, {
            payloadRoot: payloadRoot,
            scriptsRoot: scriptsRoot,
            identifier: pkgId,
            title: opts.displayName,
            welcome: welcome,
            backgroundPath: opts.backgroundPath
        });
        return {
            pkg: pkgBuffer,
            uninstallPkg: uninstallPkg,
            uninstall: replaceTokens(UNINSTALL, tokens)
        };
    } finally {
        await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
}

module.exports = { createMacOSInstaller };
