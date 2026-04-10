# Scenario C: Cloud Relay Deployment Guide (Oracle Cloud)

Because the DTU device relies on a **Raw TCP Socket** instead of standard HTTP web traffic, standard web hosting providers (like Render or Vercel) will bounce the connection. We must use a full virtual machine. 

This guide covers creating an **Always Free Oracle Cloud** server to act as a permanent, public bridge from your DTU to LakeLedger. Oracle has the most generous free tier, providing up to 4 ARM-based servers permanently for free.

### 1. Launch a Free Oracle Compute Instance
1. **Create an account** at [cloud.oracle.com](https://cloud.oracle.com/) (Requires a credit card for verification, but you will not be charged for Always Free resources).
2. Once logged in, click **Create a VM instance**.
3. **Name it:** `dtu-bridge-vm`.
4. **Image and Shape:** 
   - Ensure the image is **Canonical Ubuntu** (e.g., 22.04).
   - Ensure the shape says **Always Free Eligible** (either `VM.Standard.E2.1.Micro` or `VM.Standard.A1.Flex` ARM processor).
5. **Networking:** In the Primary VNIC section, ensure "Assign a public IPv4 address" is checked.
6. **Add SSH keys:** Select "Generate a key pair for me" and click **Save private key** to download your `.key` file. You will need this to connect!
7. Click **Create** at the bottom.

### 2. Open the TCP Port in Oracle's Firewall (VCN)
Oracle blocks custom ports by default on the cloud panel.
1. On your instances page, click on your new `dtu-bridge-vm`.
2. Under **Primary VNIC**, click on the **Subnet** link.
3. Click your **Security List** (usually named `Default Security List for...`).
4. Click **Add Ingress Rules**.
5. **Source CIDR:** `0.0.0.0/0`
6. **IP Protocol:** `TCP`
7. **Destination Port Range:** `3000`
8. Click **Add Ingress Rules**.

### 3. Connect to Your Server
Open your computer's terminal (Command Prompt, PowerShell, or Mac Terminal) and SSH into the server using the private key you downloaded:

```bash
# Example syntax (note: the default user is 'ubuntu')
ssh -i "C:\path\to\your\ssh-key-2023-xx-xx.key" ubuntu@YOUR_ORACLE_PUBLIC_IP
```

### 4. Open the Internal Linux Firewall
Oracle Cloud images have a strict internal Linux firewall *in addition* to the cloud firewall. Run this inside the terminal to open port 3000 on the VM itself:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3000 -j ACCEPT
sudo netfilter-persistent save
```

### 5. Install Node.js & Download the Kit
Now, run these commands to install Node.js and download your code:

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

### 6. Run the Bridge Permanently!
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

### 7. Update your DTU Settings
Your bridge is now live on the internet! 

1. Copy the **Public IP Address** of your Oracle VM.
2. In your physical DTU interface, configure it to send data to a Custom Server.
3. **Target IP:** `<YOUR_ORACLE_PUBLIC_IP>` 
4. **Target Port:** `3000`

The DTU will connect directly to your Oracle Virtual Machine, and `bridge.js` will securely process the raw TCP packets and pump them straight to LakeLedger.
