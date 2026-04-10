# Scenario C: Cloud Relay Deployment Guide (AWS EC2)

Because the DTU device relies on a **Raw TCP Socket** instead of standard HTTP web traffic, standard web hosting providers (like Render or Vercel) will bounce the connection. We must use a full virtual machine. 

This guide covers creating a free 12-month **Amazon Web Services (AWS)** server to act as a permanent, public bridge from your DTU to LakeLedger.

### 1. Launch a Free AWS EC2 Instance
1. **Create an account** at [aws.amazon.com](https://aws.amazon.com/) (you get an EC2 Linux VM free for 12 months).
2. Go to the **EC2 Dashboard** and click **Launch Instance**.
3. **Name it:** `LakeLedger-DTU-Bridge`.
4. **OS:** Select **Ubuntu** (the free-tier eligible version).
5. **Instance Type:** Select `t2.micro` or `t3.micro` (Free-tier eligible).
6. **Key Pair:** Create a new ".pem" key pair, name it something like `dtu-bridge-key`, and download it to your computer. You will need this to access your server!
7. **Network Settings:** 
   - Check the box to "Allow SSH traffic from Anywhere".
   - Click "Launch Instance".

### 2. Open the TCP Port in AWS
AWS firewalls block raw ports by default. We need to open Port 3000 so the DTU can connect.
1. In your EC2 dashboard, click on your running instance.
2. Under the **Security** tab, click the Security Group link (like `sg-0abc123...`).
3. Click **Edit inbound rules** -> **Add Rule**.
4. Set **Type:** Custom TCP.
5. Set **Port Range:** `3000`.
6. Set **Source:** Anywhere-IPv4 (`0.0.0.0/0`).
7. Save the rule.

### 3. Connect to Your Server
Open your computer's terminal (Command Prompt, PowerShell, or Mac Terminal) and SSH into the server using the `.pem` key you downloaded:

```bash
# Example syntax:
ssh -i /path/to/dtu-bridge-key.pem ubuntu@YOUR_EC2_PUBLIC_IP
```

### 4. Install Node.js & Download the Kit
Once you are logged into your Ubuntu server terminal, run these exact commands one by one to install Node.js and download your code:

```bash
# 1. Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Download your Code repository
git clone https://github.com/kbvideo6/Scenario_C_Cloud_Relay_Kit.git
cd Scenario_C_Cloud_Relay_Kit

# 3. Install packages
npm install
```

### 5. Run the Bridge Permanently!
We will use an app called `PM2` to run the bridge in the background so it stays alive even if you close your terminal or the server restarts.

```bash
# 1. Install PM2
sudo npm install -g pm2

# 2. Start the bridge
pm2 start bridge.js --name "dtu-gateway"

# 3. (Optional) Save it so it auto-starts on reboot
pm2 save
pm2 startup
```

### 6. Update your DTU Settings
Your bridge is now live on the internet! 

1. Copy the **Public IPv4 Address** of your AWS EC2 instance.
2. In your physical DTU interface, configure it to send data to a Custom Server.
3. **Target IP:** `<YOUR_EC2_PUBLIC_IP>` 
4. **Target Port:** `3000`

The DTU will connect to your AWS Server, and the AWS server will securely package the data and forward it to the LakeLedger MQTT platform over TLS.
