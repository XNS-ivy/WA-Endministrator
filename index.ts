import "@utils/logger"
import Hoshino from "@modules/baileys/main"

// need future update can be scan from frontend or connect from frontend or see command aka web console
const staticPhoneNumber = null

async function start() {
    await Hoshino.startWhatsapp(staticPhoneNumber)
}

start().catch(console.error)