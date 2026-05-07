import "@utils/logger"
import WAEndmin from "@modules/baileys/main"

// need future update can be scan from frontend or connect from frontend or see command aka web console
const statisPhoneNumber = null

async function start() {
    await WAEndmin.startWhatsapp(statisPhoneNumber)
}

start().catch(console.error)