import { access } from "node:fs/promises";
import path from "node:path";
import { googleLogin } from "./google-login.js";
import { loadPersonal } from "./settings.js";
import { createWeather } from "./weather.js";

const root = process.cwd();
const secrets = path.join(root, "data/secrets");
const personal = () => loadPersonal(path.join(root, "config/.private/personal.json"));
const [command, file] = process.argv.slice(2);
try {
    if (command === "google-login" && file) await googleLogin(path.resolve(file), secrets);
    else if (command === "weather-check") {
        const result = await createWeather({ secretRoot: secrets })(await personal());
        console.log(JSON.stringify({ available: true, days: result.days.length, hours: result.hours.length }));
    } else if (command === "status") {
        const exists = (name) => access(path.join(secrets, name)).then(() => true, () => false);
        console.log(JSON.stringify({ personalSettings: Boolean(await personal()),
            weather: await exists("weatherkit.json"), calendar: await exists("google-token.json") }, null, 2));
    } else throw Error("Use status, weather-check or google-login <desktop-client.json>");
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
