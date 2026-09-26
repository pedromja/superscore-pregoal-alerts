import webpush from 'web-push'

const keys = webpush.generateVAPIDKeys()
const subject = process.env.VAPID_SUBJECT || 'mailto:dev@localhost'

console.log('# Cole no .env (nunca commitar a chave privada)')
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`)
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`)
console.log(`VAPID_SUBJECT=${subject}`)
