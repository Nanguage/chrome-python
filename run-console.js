"use strict";

window.app = {};

function sleep(s) {
    return new Promise((resolve) => setTimeout(resolve, s));
}

async function restart() {
    const body = $("body");
    $(".terminal")[0].remove();
    window.console_ready = initConsole();
    await window.console_ready;
}

async function mountNativeFs(mountPoint = "/mount_dir") {
    const pyodide = window.pyodide;
    const dirHandle = await showDirectoryPicker();
    if ((await dirHandle.queryPermission({ mode: "readwrite" })) !== "granted") {
        if (
            (await dirHandle.requestPermission({ mode: "readwrite" })) !== "granted"
        ) {
            throw Error("Unable to read and write directory");
        }
    }
    const nativefs = await pyodide.mountNativeFS(mountPoint, dirHandle);
}

function updateButtonLabel() {
    $(".fa-home").map((_, el) => {
        el.innerHTML = "Home";
    });
    $(".fa-arrow-left").map((_, el) => {
        el.innerHTML = "Back";
    });
    $(".fa-arrow-right").map((_, el) => {
        el.innerHTML = "Forward";
    });
    $(".fa-arrows").map((_, el) => {
        el.innerHTML = "Pan";
    });
    $(".fa-search-plus").map((_, el) => {
        el.innerHTML = "Zoom";
    });
}

function toBool(value, default_value = false) {
    if (value === undefined || value === null) return default_value;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
        switch (value.toLowerCase().trim()) {
            case "true": case "yes": case "1": return true;
            case "false": case "no": case "0": case null: return false;
            default: return Boolean(value);
        }
    }
}

function toDigits(i, digits) {
    return i.toString().padStart(digits, "0");
}

async function runFile(url, showCode = true) {
    const term = window.term;
    const response = await fetch(url);
    let text = await response.text();
    text = text.replaceAll("\r\n", "\n");
    text = "\n" + text;
    const p = term.exec(text, !showCode);
    await p;
}

function toJs(value) {
    if (value instanceof pyodide.ffi.PyProxy) {
        if (value instanceof pyodide.ffi.PyDict) {
            let map = value.toJs();
            const obj = {};
            for (const [key, value] of map) {
                obj[key] = toJs(value);
            }
            return obj;
        } else {
            return value.toJs();
        }
    } else {
        return value;
    }
}


async function initConsole() {
    let indexURL = chrome.runtime.getURL("libs/");
    const urlParams = new URLSearchParams(window.location.search);
    const { loadPyodide } = await import(indexURL + "pyodide.mjs");
    // to facilitate debugging
    globalThis.loadPyodide = loadPyodide;

    let term;
    globalThis.pyodide = await loadPyodide({
        stdin: () => {
            let result = prompt();
            echo(result);
            return result;
        },
    });
    let namespace = pyodide.globals.get("dict")();
    pyodide.runPython(
        `
    import sys
    from pyodide.ffi import to_js
    from pyodide.console import PyodideConsole, repr_shorten, BANNER
    import __main__
    BANNER = "Welcome to the Pyodide terminal emulator 🐍"
    pyconsole = PyodideConsole(__main__.__dict__)
    import builtins
    async def await_fut(fut):
      res = await fut
      if res is not None:
        builtins._ = res
      return to_js([res], depth=1)
    def clear_console():
      pyconsole.buffer = []
`,
        { globals: namespace },
    );
    let repr_shorten = namespace.get("repr_shorten");
    let banner = namespace.get("BANNER");
    let await_fut = namespace.get("await_fut");
    let pyconsole = namespace.get("pyconsole");
    let clear_console = namespace.get("clear_console");
    const echo = (msg, ...opts) =>
        term.echo(
            msg
                .replaceAll("]]", "&rsqb;&rsqb;")
                .replaceAll("[[", "&lsqb;&lsqb;"),
            ...opts,
        );
    namespace.destroy();

    let ps1 = ">>> ",
        ps2 = "... ";

    async function lock() {
        let resolve;
        let ready = term.ready;
        term.ready = new Promise((res) => (resolve = res));
        await ready;
        return resolve;
    }

    async function interpreter(command) {
        let unlock = await lock();
        term.pause();
        // multiline should be split (useful when pasting)
        let counter = 0;
        const lines = command.split("\n");
        for (const c of lines) {
            counter++;
            const escaped = c.replaceAll(/\u00a0/g, " ");
            let fut = pyconsole.push(escaped);
            term.set_prompt(fut.syntax_check === "incomplete" ? ps2 : ps1);
            switch (fut.syntax_check) {
                case "syntax-error":
                    term.error(fut.formatted_error.trimEnd());
                    continue;
                case "incomplete":
                    continue;
                case "complete":
                    break;
                default:
                    throw new Error(`Unexpected type ${ty}`);
            }
            // In JavaScript, await automatically also awaits any results of
            // awaits, so if an async function returns a future, it will await
            // the inner future too. This is not what we want so we
            // temporarily put it into a list to protect it.
            let wrapped = await_fut(fut);
            // complete case, get result / error and print it.
            try {
                const mplShow = escaped.includes("plt.show()");
                let mplTarget = null;
                if (mplShow) {
                    term.echo();
                    const outputs = $(".terminal-output")[0].children
                    mplTarget = outputs[outputs.length - 1]
                    document.pyodideMplTarget = mplTarget
                }
                // Real execution happens here.
                let [value] = await wrapped;
                if (mplShow) {
                    if (mplTarget) {
                        mplTarget.children[0].style.display = "none";
                        if (mplTarget.children.length > 1) {
                            mplTarget.children[1].removeAttribute("id")
                        }
                    }
                    updateButtonLabel();
                }
                if (value !== undefined) {
                    echo(
                        repr_shorten.callKwargs(value, {
                            separator: "\n<long output truncated>\n",
                        }),
                    );
                }
                if (value instanceof pyodide.ffi.PyProxy) {
                    value.destroy();
                }
            } catch (e) {
                if (e.constructor.name === "PythonError") {
                    const message = fut.formatted_error || e.message;
                    let msg = "";
                    if (lines.length > 1) {
                        // print the error position in multiline mode
                        const limit = 3;
                        const maxDigits = (counter + limit).toString().length;
                        msg += `Error occred at line ${counter}:\n`;
                        msg += "----------------------------------------\n"
                        let i = 0;
                        for (const line of lines) {
                            i++;
                            if (i === counter) {
                                msg += toDigits(i, maxDigits) + ": " + line + "    <-- Error here!" + "\n";
                            } else if ((i >= counter - limit) && (i <= counter + limit)) {
                                msg += toDigits(i, maxDigits) + ": " + line + "\n";
                            }
                        }
                        msg += "----------------------------------------\n"
                    }
                    msg += message.trimEnd();
                    term.error(msg);
                    break;
                } else {
                    throw e;
                }
            } finally {
                fut.destroy();
                wrapped.destroy();
            }
        }
        term.resume();
        await sleep(10);
        unlock();
    }

    term = $("body").terminal(interpreter, {
        greetings: banner,
        prompt: ps1,
        completionEscape: false,
        completion: function (command, callback) {
            callback(pyconsole.complete(command).toJs()[0]);
        },
        keymap: {
            "CTRL+C": async function (event, original) {
                clear_console();
                term.enter();
                echo("KeyboardInterrupt");
                term.set_command("");
                term.set_prompt(ps1);
            },
            TAB: (event, original) => {
                const command = term.before_cursor();
                // Disable completion for whitespaces.
                if (command.trim() === "") {
                    term.insert("\t");
                    return false;
                }
                return original(event);
            },
        },
    });
    window.term = term;
    pyconsole.stdout_callback = (s) => echo(s, { newline: false });
    pyconsole.stderr_callback = (s) => {
        term.error(s.trimEnd());
    };
    term.ready = Promise.resolve();
    pyodide._api.on_fatal = async (e) => {
        if (e.name === "Exit") {
            term.error(e);
            term.error("Pyodide exited and can no longer be used.");
        } else {
            term.error(
                "Pyodide has suffered a fatal error. Please report this to the Pyodide maintainers.",
            );
            term.error("The cause of the fatal error was:");
            term.error(e);
            term.error("Look in the browser console for more details.");
        }
        await term.ready;
        term.pause();
        await sleep(15);
        term.pause();
    };

    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.has("noblink")) {
        $(".cmd-cursor").addClass("noblink");
    }

    document.pyodideMplTarget = $(".terminal-wrapper")[0]

    term.echo("--- Initializing ---")
    term.pause();

    term.resume();

    $.terminal.syntax("python");
}
window.console_ready = initConsole();