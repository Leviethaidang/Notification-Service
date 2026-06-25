require('dotenv').config();

const AWS = require('aws-sdk');

AWS.config.update({
    region: process.env.AWS_REGION || 'ap-southeast-1'
});

const sqs = new AWS.SQS();
const ses = new AWS.SES();

const NOTIFICATION_REQUESTED_QUEUE_URL = process.env.NOTIFICATION_REQUESTED_QUEUE_URL;
const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

if (!NOTIFICATION_REQUESTED_QUEUE_URL) {
    console.error('Thiếu NOTIFICATION_REQUESTED_QUEUE_URL trong .env');
    process.exit(1);
}
if (!SES_FROM_EMAIL) {
    console.error('Thiếu SES_FROM_EMAIL trong .env');
    process.exit(1);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseSqsMessageBody(body) {
    const parsed = JSON.parse(body);

    if (parsed.eventType) {
        return parsed;
    }

    if (parsed.Message) {
        return JSON.parse(parsed.Message);
    }

    return parsed;
}

function formatMoney(value) {
    const numberValue = Number(value || 0);

    return new Intl.NumberFormat('vi-VN', {
        style: 'currency',
        currency: 'VND'
    }).format(numberValue);
}

function buildItemsText(items = []) {
    if (!Array.isArray(items) || items.length === 0) {
        return '- Không có sản phẩm';
    }

    return items.map(item => {
        const variantParts = [];

        if (item.sizeName) {
            variantParts.push(`Size: ${item.sizeName}`);
        }

        if (item.colorName) {
            variantParts.push(`Màu: ${item.colorName}`);
        }

        const variantText = variantParts.length > 0
            ? ` (${variantParts.join(', ')})`
            : '';

        return `- ${item.productName}${variantText} x ${item.quantity} = ${formatMoney(item.subtotal)}`;
    }).join('\n');
}

function buildOrderSummary(order) {
    return `
Mã đơn: #${order.orderId}
Khách hàng: ${order.receiverName}
Số điện thoại: ${order.receiverPhone}
Email nhận thông báo: ${order.customerEmail || 'Không có'}
Địa chỉ giao hàng: ${order.shippingAddress}
Thanh toán: ${order.paymentMethodDisplayName || order.paymentMethodType}
Trạng thái đơn: ${order.orderStatus}
Trạng thái thanh toán: ${order.paymentStatus}
Tổng số lượng: ${order.totalQuantity}
Tổng tiền: ${formatMoney(order.totalAmount)}

Sản phẩm:
${buildItemsText(order.items)}
`.trim();
}

async function sendEmail({ to, subject, text }) {
    if (!to) {
        console.log('[EMAIL SKIP] Thiếu người nhận:', subject);

        return {
            sent: false,
            reason: 'MISSING_RECIPIENT'
        };
    }

    const result = await ses.sendEmail({
        Source: SES_FROM_EMAIL,
        Destination: {
            ToAddresses: [to]
        },
        Message: {
            Subject: {
                Data: subject,
                Charset: 'UTF-8'
            },
            Body: {
                Text: {
                    Data: text,
                    Charset: 'UTF-8'
                }
            }
        }
    }).promise();

    console.log('[EMAIL SENT]', {
        to,
        subject,
        messageId: result.MessageId
    });

    return {
        sent: true,
        messageId: result.MessageId
    };
}

async function notifyOrderConfirmed(event) {
    const order = event.order;

    const customerText = `
Xin chào ${order.receiverName},

Cảm ơn bạn đã đặt hàng tại HaShop.
Đơn hàng của bạn đã được xác nhận.

${buildOrderSummary(order)}

HaShop sẽ chuẩn bị đơn hàng của bạn trong thời gian sớm nhất.
`.trim();

    const adminText = `
Có đơn hàng mới cần xử lý.

${buildOrderSummary(order)}

Vui lòng kiểm tra size/màu/số lượng để đóng gói đúng sản phẩm.
`.trim();

    const results = [];

    results.push(await sendEmail({
        to: order.customerEmail,
        subject: `HaShop xác nhận đơn hàng #${order.orderId}`,
        text: customerText
    }));

    if (ADMIN_EMAIL) {
        results.push(await sendEmail({
            to: ADMIN_EMAIL,
            subject: `Đơn hàng mới #${order.orderId} cần đóng gói`,
            text: adminText
        }));
    }

    return results;
}

async function notifyPaymentFailed(event) {
    const order = event.order;

    const text = `
Xin chào ${order.receiverName},

Đơn hàng #${order.orderId} của bạn thanh toán thất bại.

Lý do: ${order.paymentError || event.extra?.reason || 'Không rõ'}

Đơn hàng này sẽ không được xử lý. Bạn có thể đặt lại đơn hàng và chọn phương thức thanh toán khác.

${buildOrderSummary(order)}
`.trim();

    return sendEmail({
        to: order.customerEmail,
        subject: `Thanh toán thất bại cho đơn hàng #${order.orderId}`,
        text
    });
}

async function notifyOrderCancelled(event) {
    const order = event.order;
    const cancelledBy = event.extra?.cancelledBy || 'UNKNOWN';

    const customerText = cancelledBy === 'ADMIN'
        ? `
Xin chào ${order.receiverName},

Đơn hàng #${order.orderId} của bạn đã được shop hủy.

${buildOrderSummary(order)}

Nếu cần hỗ trợ thêm, vui lòng liên hệ HaShop.
`.trim()
        : `
Xin chào ${order.receiverName},

HaShop xác nhận đơn hàng #${order.orderId} của bạn đã được hủy thành công.

${buildOrderSummary(order)}
`.trim();

    const adminText = `
Đơn hàng #${order.orderId} đã bị hủy.

Người hủy: ${cancelledBy}

${buildOrderSummary(order)}

Nếu đơn này đang được chuẩn bị, vui lòng dừng đóng gói/giao hàng.
`.trim();

    const results = [];

    results.push(await sendEmail({
        to: order.customerEmail,
        subject: `Đơn hàng #${order.orderId} đã được hủy`,
        text: customerText
    }));

    if (ADMIN_EMAIL) {
        results.push(await sendEmail({
            to: ADMIN_EMAIL,
            subject: `Đơn hàng #${order.orderId} đã bị hủy`,
            text: adminText
        }));
    }

    return results;
}

async function notifyOrderShipping(event) {
    const order = event.order;

    const text = `
Xin chào ${order.receiverName},

Đơn hàng #${order.orderId} của bạn đang được giao.

${buildOrderSummary(order)}

Vui lòng chú ý điện thoại để nhận hàng.
`.trim();

    return sendEmail({
        to: order.customerEmail,
        subject: `Đơn hàng #${order.orderId} đang được giao`,
        text
    });
}

async function notifyOrderCompleted(event) {
    const order = event.order;

    const customerText = `
Xin chào ${order.receiverName},

Cảm ơn bạn đã mua hàng tại HaShop.
Đơn hàng #${order.orderId} đã hoàn tất.

${buildOrderSummary(order)}

Hy vọng bạn hài lòng với sản phẩm.
`.trim();

    const adminText = `
Đơn hàng #${order.orderId} đã hoàn tất.

${buildOrderSummary(order)}
`.trim();

    const results = [];

    results.push(await sendEmail({
        to: order.customerEmail,
        subject: `Cảm ơn bạn đã mua hàng tại HaShop - Đơn #${order.orderId}`,
        text: customerText
    }));

    if (ADMIN_EMAIL) {
        results.push(await sendEmail({
            to: ADMIN_EMAIL,
            subject: `Đơn hàng #${order.orderId} đã hoàn tất`,
            text: adminText
        }));
    }

    return results;
}

async function processNotificationEvent(event) {
    if (!event || !event.eventType) {
        throw new Error('Notification event không hợp lệ!');
    }

    if (!event.order || !event.order.orderId) {
        throw new Error('Notification event thiếu thông tin order!');
    }

    console.log('[EVENT] Received:', event.eventType, 'orderId=', event.order.orderId);

    switch (event.eventType) {
        case 'ORDER_CONFIRMED':
            return notifyOrderConfirmed(event);

        case 'ORDER_PAYMENT_FAILED':
            return notifyPaymentFailed(event);

        case 'ORDER_CANCELLED':
            return notifyOrderCancelled(event);

        case 'ORDER_SHIPPING':
            return notifyOrderShipping(event);

        case 'ORDER_COMPLETED':
            return notifyOrderCompleted(event);

        default:
            console.log('[SKIP] Event không cần gửi email:', event.eventType);

            return {
                skipped: true,
                reason: 'UNSUPPORTED_EVENT_TYPE'
            };
    }
}

async function deleteMessage(receiptHandle) {
    await sqs.deleteMessage({
        QueueUrl: NOTIFICATION_REQUESTED_QUEUE_URL,
        ReceiptHandle: receiptHandle
    }).promise();
}

async function processMessage(message) {
    const receiptHandle = message.ReceiptHandle;

    try {
        const event = parseSqsMessageBody(message.Body);

        const result = await processNotificationEvent(event);

        console.log('[DONE] Notification processed:', result);

        await deleteMessage(receiptHandle);

        console.log('[DELETE] SQS notification message deleted.');

    } catch (error) {
        console.error('[ERROR] Không thể xử lý notification:', error.message);

        // Không delete nếu lỗi kỹ thuật để SQS retry.
        // Nếu message sai format do test thủ công thì xóa thủ công khỏi queue.
    }
}

async function pollMessages() {
    console.log('Notification worker started.');
    console.log(`Listening notification queue: ${NOTIFICATION_REQUESTED_QUEUE_URL}`);
    console.log(`SES_FROM_EMAIL=${SES_FROM_EMAIL}`);
    console.log(`ADMIN_EMAIL=${ADMIN_EMAIL || 'Không cấu hình'}`);

    while (true) {
        try {
            const result = await sqs.receiveMessage({
                QueueUrl: NOTIFICATION_REQUESTED_QUEUE_URL,
                MaxNumberOfMessages: 5,
                WaitTimeSeconds: 20,
                VisibilityTimeout: 60
            }).promise();

            const messages = result.Messages || [];

            if (messages.length === 0) {
                continue;
            }

            console.log(`[POLL] Received ${messages.length} notification message(s).`);

            for (const message of messages) {
                await processMessage(message);
            }

        } catch (error) {
            console.error('[POLL ERROR]', error.message);
            await sleep(3000);
        }
    }
}

process.on('SIGINT', () => {
    console.log('Notification worker received SIGINT. Exiting...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Notification worker received SIGTERM. Exiting...');
    process.exit(0);
});

pollMessages();