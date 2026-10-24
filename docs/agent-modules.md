# Agent modules: versioned updates and the disk module warnings

## 1. Goal

A module the server pushes to an agent should replace the agent's built-in copy when it is newer, and nothing else should be able to replace it without someone noticing.

Two problems in the old behavior:
- The server pushed modules without a date, so the agent skipped every push that had a built-in copy. The date is sent now, but a file date is a weak version.
- A `<name>.js` file in the agent's working directory replaced any module, built-in or pushed. Anyone who could write there could run code as the agent, and nothing reported it.

What this adds:
- A version line in a module file, so a newer module wins on version and not on file date.
- Disk modules are off by default, and on only with the `-allowDiskModules` switch or in a debug build.
- The server tells administrators when an agent has disk modules enabled, has loaded one, or has `.js` files in its working directory.

The agent side is in the MeshAgent repository. An older agent still works with this server and keeps the old rules (see section 2.5).

## 2. Design

### 2.1 Version line

A module file may start with `/*! @module-version=N */`. Only the first line counts, after a byte order mark and blank lines. The tag is not case sensitive, `=` and a decimal number follow it directly, and 0 means no version line. The `/*!` form is used because minifiers keep such a comment.

The server reads it in `buildAddModuleLine()` in `meshcentral.js`, only to list the modules in the `modules` server console command. The agent decides on its own, so the server never needs to know what version an agent has.

Every file in `agents/modules_meshcore` and `agents/modules_meshcmd` starts at version 1. **Raise the number with every change to a module file.** A higher version replaces the agent's copy in every case. With an equal version and different text the pushed copy still wins, but the agent treats that as a conflict and logs "added again with different content" once per run. The same holds for a plugin's `modules_meshcore` folder, which `pluginHandler.js` pushes the same way.

### 2.2 Server push

`updateMeshCore()` and `updateMeshCmd()` add one `addModule(name, source, date)` call per file in `agents/modules_meshcore` and `agents/modules_meshcmd` in front of the core. The date is the file modification time. `addModule()` returns false when the agent kept its own copy, and the name is then left out of `addedModules`.

MeshCmd is the agent binary with `meshcmd.js` merged in. None of the `modules_meshcmd` modules is built into the agent, so the version only matters there once one is. MeshCmd never connects as an agent, so it sends no report of section 3. A `.js` file next to a MeshCmd built from a new agent is not loaded any more, as mode 0 applies to it too.

### 2.3 Agent decision

For each pushed module, the agent compares with its built-in copy, never with a disk file:
1. Same text: nothing is added.
2. Either copy has a version: the higher version wins, no version counts as 0. Equal versions with different text: the pushed copy wins, and the agent logs it once.
3. Neither has a version: the pushed copy wins with a newer date.

A `<name>.js` file in the working directory is only read in these modes:

| mode | meaning | how |
|---|---|---|
| 0 | never | release default |
| 1 | only for names that have no module | script mode |
| 2 | replaces built-in and pushed modules | `-allowDiskModules` on the command line |
| 3 | same as 2 | debug build |

The switch is read from the command line only, never from the `.msh` or the database, because those sit next to a planted file and the database can be written by the server.

On an agent installed as a service, an admin can add the switch to the service's command line when needed, and restart the service:
- Windows: the service's ImagePath, for example `sc config "Mesh Agent" binPath= "\"C:\Program Files\Mesh Agent\MeshAgent.exe\" -allowDiskModules"`.
- Linux: the `ExecStart=` line of the systemd unit, then `systemctl daemon-reload`.
- macOS: an extra `<string>` under `ProgramArguments` in the launchd plist.

A self-update keeps it, because the service manager restarts the agent with the same command line. A reinstall writes a new service definition without it, so it has to be added again.

### 2.4 Console commands

Device Console tab, on the agent:

```
modules [options]   every module with source, version, date, loaded, replaced by, ignored copy
  l  only loaded modules                  i  only modules built into the agent
  s  only modules added by the server     d  only modules from a file in the working directory
  n  only native modules (C code in the agent), a JavaScript copy of the same name is never loaded
  r  only loaded modules that were replaced after they were loaded
  e  expanded JSON                        options combine, for example "modules ls"
```

"Replaced by" means the copy a new `require()` would load differs from the loaded one: after an `addModule()` while the agent runs, until the next `require()` of that name loads the new copy, or in mode 2 or 3 when a file in the working directory changes. Code that already holds the old instance keeps it.

My Server > Console, full administrators:

```
modules     the modules the cores and MeshCmd were built from, with version and date, plugin modules included
modules w   the connected agents that report disk module files
```

The server also puts one line in the device's General tab (the agent message bullet) while a report is active: "Agent has loading module files enabled (-allowDiskModules)" or "(Debug build)", or "Agent has module files in its working directory, loading=enabled" or "loading=disabled", followed by the file list with the 10 cap. It follows the report, and comes back after a reconnect from the device record.

### 2.5 Compatibility

| | old agent | new agent |
|---|---|---|
| old server | date rule | date rule, no report |
| this server | date rule, version line is a comment, `.js` files in the working directory are reported as `oldagent` | version rule, full report |

The `dm` field of section 3 is ignored by an old server. This server does not change the stored state when a core sends no `dm`.

## 3. The `coreinfo` addition

The core builds `meshCoreObj.dm` at start and sends it inside `coreinfo`, like the other device info (`av`, `wsc`, `idletime`). `coreinfo` goes out at every connect and again when the object changes, so the report does not need its own message. Where it matters, the core reads the directory again on its regular info run (table below).

```
dm: { mode, files, loaded }
```

- `mode`: the disk mode of section 2.3, 0, 2 or 3, or `null` on an agent without the module handling. The core sends what it knows and draws no conclusion.
- `files`: the names of `*.js` entries in the working directory, by name only, so a directory `x.js` counts. Not read in mode 1. Names that would replace a module (`getModules(true)`, built-in, pushed and native) come first, each group sorted, so the popup's 10 names never hide them behind the count. The server keeps this order.
- `loaded`: the sorted names of modules loaded from disk before the core started (modes 2 and 3). In mode 2 a load later in the run is added and `coreinfo` is sent again.

| mode | directory read again | later loads added | why |
|---|---|---|---|
| 0 | at connect and on the `coreinfoupdate` console command | no | Nothing loads, the re-read only lets a removed file clear the warning |
| 2 | at connect, every 5 minutes, on `coreinfoupdate` | yes | A file added later can replace a module |
| 3 | no | no | Loading from disk is how a debug build works, the start report marks it |
| `null` | at connect, every 5 minutes, on `coreinfoupdate` | not possible | An old agent loads a file added later without any event |

Mode 1 is script mode, where the core does not run. The core also writes the list to the agent's own log: one line at start when there are files or in mode 2 or 3, and one when a re-read finds a change. The agent itself only logs the switch and the disk loads that replace a module.

The server (`processDiskModulesReport()` in `meshagent.js`):
1. Drops the report when `mode` is not one of those values, and derives the reason: `allowdisk` (mode 2), `debug` (mode 3), `notloaded` (mode 0 with a file) or `oldagent` (`null` with a file). Mode 0 or `null` without a file means nothing to report.
2. Keeps the names that match `/^[\w.\- ]{1,64}$/` among the first 1000, and counts the rest as `others`, so an oddly named file cannot hide a warning.
3. Sets the state on the connection (`obj.diskModules`) and in `parent.diskModuleAgents`, which the login warning and `modules w` read.
4. Compares `reason`, `files`, `others` and `loaded` with `device.agent.dm` in the device record. Same: nothing else happens. Different: stores the new state, saved by the existing `db.Set` of `ChangeAgentCoreInfo()`. A new state (the first report, or another reason) writes the event lines and raises the popup. In the same state, new files write event 177 and a popup naming them, fewer files write nothing.
5. Fills the connection from the record when the agent connects, so the login warning works before the first `coreinfo` and after a server restart. A record that is not an object is dropped.

`device.agent.dm` is removed when there is nothing to report. It is part of the node record, so every user with rights on the device gets it in the browser, file names included.

## 4. Popups, warnings and the event log

Why the server compares and not the agent: a reconnect, or a server restart, must not repeat anything. The core cannot know what the server already told, the device record does.

The sizes assume what is there in practice: a couple of files next to the binary, not hundreds. The limits below (10 names in a popup, one event line, 1000 names scanned) exist so an odd case cannot break anything, not because such lists are expected.

**Popup** (live, to users with rights on the device):
- Once per change of the report, not per connect: the full text for a new state, only the new names when files were added in the same state.
- A newly loaded module also gets one, from the working directory or another one, but only with `allowdisk`, with the whole name like the event line. A debug build loads from disk all the time and gets none.
- At most 10 file names, then "and N other file(s)".

**Login warning** (an administrator, or a user with rights, who logs in later):
- One notification per connected agent with a report, with a link to its Events tab. At most 10, then one notice with the number of agents left.
- Only connected agents. An offline agent is not looked up, to keep the login free of a database query.
- `modules w` in My Server > Console lists them all.

**Event log**, written by the server so the text is the same for every core:

| id | when |
|---|---|
| 167 | `oldagent`: the files |
| 168 | `debug` |
| 169 | a module loaded from disk, one line per module, also from another directory than the working directory (a path in the module id, or `setModulePath()`), with the whole name |
| 170 | `allowdisk`: the modules loaded now |
| 171 | `notloaded`: the files |
| 172 | `allowdisk` and `debug`: the files |
| 177 | new files in the same state: the new files first, then all files |

Ids 173-176 are the bullet texts above, with the file list as argument.

- One line per report. It holds the names that fit in about 3800 characters, because an agent log line is limited to 4096, and counts the rest as "and N other file(s)". Line 177 splits that between the new files (1000) and all files (2800). With names of usual length that is a few hundred files.
- Lines are written when the report changed, so a reconnect writes nothing.
- The text is English with a `msgid`, the web pages translate through `eventsMessageId`. The popup and login texts (ids 35-45) go through `translatedMessages`. The login warning is translated; the live popup arrives as an event, and the pages' event handler does not read `msgid` from inside an event yet, so it shows the English text (fixed on a separate branch). The strings are in `translate/translate.json`, still without translations.

Limits worth knowing:
- The directory check covers `*.js` in the working directory only. A module id with a path, or a folder set with `setModulePath()`, is not listed. A new agent writes a `setModulePath()` call to its own log.
- A planted module can patch anything in the agent. The warning is a signal, not a guard.
