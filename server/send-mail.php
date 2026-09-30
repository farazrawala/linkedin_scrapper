<?php
/**
 * Job Post Finder — local mail relay.
 *
 * Chrome extensions can't speak SMTP, so the table page POSTs the email here
 * (running on XAMPP) and this script sends it with PHPMailer.
 * The SMTP credentials come with each request from the extension's settings;
 * nothing is stored on the server.
 *
 * POST JSON:
 *   { smtp: {host, port, secure: "tls"|"ssl", user, pass, fromName},
 *     to, subject, body, attachment?: {name, type, data (base64)} }
 * Response JSON: { ok: true } or { ok: false, error: "…" }
 */

use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\Exception;

require __DIR__ . '/PHPMailer/Exception.php';
require __DIR__ . '/PHPMailer/PHPMailer.php';
require __DIR__ . '/PHPMailer/SMTP.php';

header('Content-Type: application/json; charset=utf-8');

// Only the extension may call this.
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (strpos($origin, 'chrome-extension://') !== 0) {
    http_response_code(403);
    echo json_encode(['ok' => false, 'error' => 'Forbidden origin']);
    exit;
}
header('Access-Control-Allow-Origin: ' . $origin);
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

$method = $_SERVER['REQUEST_METHOD'] ?? '';
if ($method === 'OPTIONS') exit;
if ($method !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'Use POST']);
    exit;
}

function fail($message, $code = 400)
{
    http_response_code($code);
    echo json_encode(['ok' => false, 'error' => $message]);
    exit;
}

$req = json_decode(file_get_contents('php://input'), true);
if (!is_array($req)) fail('Invalid JSON body');

$smtp = $req['smtp'] ?? [];
$to = trim($req['to'] ?? '');
$subject = trim($req['subject'] ?? '');
$body = (string) ($req['body'] ?? '');

if (empty($smtp['user']) || empty($smtp['pass'])) fail('SMTP address and app password are required');
if (!filter_var($to, FILTER_VALIDATE_EMAIL)) fail('Invalid recipient address');
if ($subject === '' || trim($body) === '') fail('Subject and body are required');

$mail = new PHPMailer(true);
try {
    $mail->isSMTP();
    $mail->Host = $smtp['host'] ?: 'smtp.gmail.com';
    $mail->Port = (int) ($smtp['port'] ?: 587);
    $mail->SMTPAuth = true;
    $mail->Username = $smtp['user'];
    $mail->Password = $smtp['pass'];
    $mail->SMTPSecure = ($smtp['secure'] ?? 'tls') === 'ssl' ? PHPMailer::ENCRYPTION_SMTPS : PHPMailer::ENCRYPTION_STARTTLS;
    $mail->CharSet = PHPMailer::CHARSET_UTF8;
    $mail->Timeout = 20;

    $mail->setFrom($smtp['user'], $smtp['fromName'] ?? '');
    $mail->addReplyTo($smtp['user'], $smtp['fromName'] ?? '');
    $mail->addAddress($to);
    $mail->Subject = $subject;
    $mail->isHTML(false);
    $mail->Body = $body;

    $att = $req['attachment'] ?? null;
    if (is_array($att) && !empty($att['data'])) {
        $bytes = base64_decode($att['data'], true);
        if ($bytes === false) fail('Attachment is not valid base64');
        $name = basename($att['name'] ?? 'CV.pdf');
        $mail->addStringAttachment($bytes, $name, PHPMailer::ENCODING_BASE64, $att['type'] ?? 'application/pdf');
    }

    $mail->send();
    echo json_encode(['ok' => true]);
} catch (Exception $e) {
    fail('Send failed: ' . $mail->ErrorInfo, 502);
}
