# Scheme: complete setup walkthrough

Narration generated locally. Footage uses clean demonstration machines and fictional example content.

## 00:00 — Set up Scheme

Welcome. In this walkthrough, we will set up Scheme on a working computer, open a real terminal in its browser, and connect from a second desktop. The footage comes from two separate Ubuntu desktop virtual machines, each with eight gigabytes of memory. They are actual computers with their own operating systems and disks. Everything shown uses a fresh demonstration account. You can pause whenever you need to copy a command. The written guides beside this video contain the commands and explain the alternatives.

## 00:31 — Choose the working computer

First, choose the computer that will do the work. Scheme calls it the host. This is where your project files, terminal sessions, and optional AI tools live. Keep it powered on and awake while you are working from another screen. The viewing device only needs a current browser and a private way to reach the host. It does not need its own Scheme installation. A monitor attached to the host is already on the same computer. A separate laptop or phone needs the connection we will set up later.

## 01:00 — Install the small prerequisites

Open the Terminal application on the host. On Ubuntu, the usual shortcut is Control, Alt, T. Use the first command in the host guide to update the package list, then install the small prerequisite tools. When sudo asks for your password, type your normal computer password and press Enter. It is normal for the characters to remain invisible. Tmux keeps the terminal sessions alive when a browser leaves. The script utility supplies the terminal connection. Git helps Scheme show project activity. Curl and unzip help with downloads. None of this requires a GitHub account.

## 01:35 — Check Node.js

Now check the Node version. Scheme needs version twenty two or newer. If your computer already has that, you can skip the installation. Otherwise, the guide uses the official nvm installer, then loads nvm into this terminal and installs Node twenty two. Copy the commands in their displayed order. Wait for each download to finish. Check the version again before continuing. A new terminal may need to load nvm if its command is not found. Scheme itself has no package dependencies and no build step, so there is no separate npm install to run inside the Scheme folder.

## 02:11 — Download and extract Scheme

Open the public Scheme project page in the host browser. The green Code button has a Download ZIP option. You can also follow the direct ZIP link in the guide. Extract the archive, then keep the resulting Scheme folder somewhere permanent, such as your home folder. Do not run it inside the archive viewer. Open the extracted folder in your file manager and choose Open in Terminal. If that option is unavailable, open Terminal yourself and change into the folder. Check that you can see the readme, the server file, and the bin folder. Those tell you that you are in the right place.

## 02:46 — Run the setup check

Run the command that makes the launcher files executable, then run Scheme Doctor. This check explains what is ready and what is missing. Fix any missing required tools before you continue. Claude Code, Codex, Ollama, and Tailscale are optional at this point. You can make a normal Shell terminal without them. Also check the character encoding. It should say UTF eight. The guide gives an Ubuntu fix if it does not. If the doctor command says it cannot find a file, check your current folder before reinstalling anything. A successful doctor check is a useful first milestone.

## 03:21 — Start the dashboard

Start Scheme from its folder and keep that terminal open. On the same working computer, open localhost on port three thousand in your browser. You should see Terminal and Connect. There is one detail for smaller computers: the default memory reserve is eight thousand mebibytes. An eight gigabyte machine may have less free memory than that, and Scheme will refuse a new session. In this test, we use the documented reserve of one thousand and twenty four. Set it in the terminal before starting Scheme. This is a reserve check, not a memory limit, and it does not make a large local model fit.

## 03:57 — Open your first terminal

Press New, choose Shell, and give the session a name you will recognize. For the first test, your home folder is fine. Start the session and wait for the prompt. Type the harmless hello command from the guide and press Enter. Seeing Scheme is ready confirms that typing in this browser reaches the working computer. You can open another tab for a different task, rename a tab, or choose a project folder. Scheme can discover folders in common places such as your projects or code directory. Only choose folders you intend the tool to work with. The browser terminal has the access of your host account.

## 04:33 — Connect a second desktop

Now move to the second computer. We are using a private SSH tunnel for this actual desktop test. Your host must already accept SSH connections from this device. The Connect panel supplies a command for your host, and the remote guide explains the pieces. Replace example names with your own host and user. Run the tunnel command on the viewing computer, keep that terminal open, and open localhost on port three thousand in its browser. Localhost now reaches the host through the tunnel. If that port is already busy, choose a different local port as the guide describes. We can see and type into the same host session from this second desktop.

## 05:13 — Use a phone or tablet

For a phone, the guides recommend Tailscale on both the host and the viewing device. Sign into your own account, then use Tailscale Serve to give the local dashboard a private HTTPS address. Open that exact address on the phone. This part involves your account: our clean desktop test does not claim to have completed your Tailscale sign in or tested a physical phone. The smaller-screen preview shows the layout and touch controls. Use the touch key bar for keys such as Escape and Control, and open Tools for the additional controls. Anyone who can access the dashboard can use the host as your account, so keep that connection private.

## 05:52 — Add the tools you use

AI tools are optional. Install the tool you want on the host, then start it once in a normal terminal and finish its own setup. Claude Code and Codex use your own access, account, and billing. We checked their installation in this clean environment; we did not sign into a cloud account. The local model option uses Claude Code with Ollama on your machine. Choose a model that actually fits your memory, download it, and configure the local model name before starting Scheme. A small model can prove the connection, but it does not promise the quality of a much larger coding model. The local launcher checks that the server and model are available and refuses to quietly fall back to a cloud service.

## 06:34 — Let Scheme start automatically

Once the first terminal works, you can install the optional background service. Keep any settings you need, including the smaller memory reserve, exported in the terminal where you run the installer. Stop the foreground server, then run the service installer from the Scheme folder. On Linux, the installer explains how the user service starts. Follow its instructions if you want it to start before you log in. We tested this by rebooting the host desktop and checking that Scheme started again. The service keeps the web dashboard available. It does not preserve a running command through a power loss or a reboot.

## 07:09 — Know what survives

Here are three different recovery cases. Closing the browser leaves the host terminal running. In our test, a job completed while the viewing browser was fully closed, and its output was there when we returned. Restarting the Scheme web service also kept that same terminal process and its unfinished job alive. Rebooting the host is different. The service returned, and saved tabs could reopen, but the old running processes were gone. If the connection stops working, first check that the host is awake, Scheme is running, and your private connection is still active. The troubleshooting guide follows that same order.

## 07:46 — Your first session is ready

Before you finish, check four things. The doctor passes its required checks. A Shell command works in the host browser. Your viewing device reaches that same session through a private connection. And you understand which tools or account connections you still need to set up. The public guides cover configuration, phones, remote desktops, and troubleshooting. Linux on these two Ubuntu ARM desktops was tested. The written Mac and Windows through WSL host paths still need separate verification. Start with one useful terminal, then add the tools you need. Scheme is ready to become the screen you return to.
